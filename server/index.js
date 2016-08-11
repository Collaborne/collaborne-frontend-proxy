'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), silent: true });

const fs = require('fs');
const pg = require('pg');
const request = require('request');
const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const url = require('url');
const NodeCache = require('node-cache');

const express = require('express');
const bodyParser = require('body-parser');
const authentication = require('express-authentication');
const helmet = require('helmet');
// TODO: also use express-authentication-oauth2?
const morgan = require('morgan');
const app = express();

// Configuration items
// Note that these should all come from the outside (via environment variables or similar).
// Credentials for AWS need to be delivered in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.
app.locals.s3 = { bucket: process.env.CFP_AWS_BUCKET };
app.locals.github = { clientId: process.env.GH_CLIENT_ID, clientSecret: process.env.GH_CLIENT_SECRET, webhookSecret: process.env.GH_WEBHOOK_SECRET };
app.locals.jwt = { key: process.env.CFP_JWT_KEY, issuer: 'Collaborne/collaborne-frontend-proxy' };
app.locals.pg = { url: process.env.DATABASE_URL };
app.locals.cfp = { appDir: process.env.CFP_APP_DIR || '../dist' };
app.locals.slack = { clientId: process.env.SLACK_CLIENT_ID, clientSecret: process.env.SLACK_CLIENT_SECRET };

app.set('port', (process.env.PORT || 5000));

const s3 = new AWS.S3();


function postgres(dbUrl) {
	/**
	 * Cache for applications.
	 *
	 * Each entry is the app id, and the value is the application
	 */
	const applicationCache = new NodeCache({ stdTTL: 60 });
	/**
	 * Cache for versions.
	 *
	 * Each entry is the app id, and the value is the array of the versions
	 */
	const versionsCache = new NodeCache({ stdTTL: 60 });

	const params = url.parse(dbUrl);
	const auth = params.auth.split(':');
	const config = {
		user: auth[0],
		password: auth[1],
		host: params.hostname,
		port: params.port,
		database: params.pathname.split('/')[1],
		ssl: process.env.NODE_ENV === 'production'
	};
	const pool = new pg.Pool(config);
	return function(req, res, next) {
		function _cachedQuery(cache, query, id, callback) {
			// TODO: Allow multiple arguments
			cache.get(id, function(err, entry) {
				if (err) {
					return callback(err, null);
				}

				if (typeof entry === 'undefined') {
					// Never cached, query immediately.
					return query(id, function(err, result) {
						if (err) {
							return callback(err, result);
						}

						return cache.set(id, result.rows, function(cacheErr, cacheSuccess) {
							return callback(err, result);
						});
					});
				} else {
					// Cached value. Note that this can be empty.
					return callback(null, {
						rows: entry,
						rowCount: entry.length
					});
				}
			});
		}

		function _invalidateCachedApp(appId) {
			applicationCache.del(appId);
		}
		function _invalidateCachedVersions(appId) {
			versionsCache.del(appId);
		}

		// See https://github.com/brianc/node-postgres/wiki/Prepared-Statements
		function SQL(parts, ...values) {
			return {
				text: parts.reduce((prev, curr, i) => `${prev}$${i}${curr}`),
				values
			};
		}

		return pool.connect(function(err, client, release) {
			if (err) {
				console.log(`Cannot connect to ${dbUrl}: ${err}`);
				return res.status(503).send({ error: 'DB unavailable' });
			}

			// http://stackoverflow.com/questions/18783385/setting-up-request-cleanup-middleware-in-expressjs
			res.on('finish', function() {
				return release();
			});

			req.db = {
				// CRUD operations
				queryUser: function(userId, callback) {
					return client.query(SQL`SELECT * FROM users WHERE id=${userId}`, callback);
				},
				queryApps: function(callback) {
					return client.query(SQL`SELECT * FROM apps`, callback);
				},
				queryApp: function(appId, callback) {
					return client.query(SQL`SELECT * FROM apps WHERE id=${appId}`, callback);
				},
				createApp: function(appId, ownerId, autoupdate, callback) {
					if (typeof autoupdate === 'function') {
						callback = autoupdate;
						autoupdate = false;
					}
					return client.query(SQL`INSERT INTO apps (id, owner, autoupdate) VALUES (${appId}, ${ownerId}, ${autoupdate})`, callback);
				},
				deleteApp: function(appId, callback) {
					return client.query(SQL`DELETE FROM apps WHERE id=${appId}`, function(err, result) {
						if (err) {
							return callback(err, result);
						}

						return client.query(SQL`DELETE FROM versions WHERE app=${appId}`, callback);
					});
				},
				queryVersions: function(appId, callback) {
					return client.query(SQL`SELECT * FROM versions WHERE app=${appId} ORDER BY row_number() OVER () DESC`, callback);
				},
				queryVersion: function(appId, versionId, callback) {
					return client.query(SQL`SELECT * FROM versions WHERE app=${appId} AND id=${versionId}`, callback);
				},
				createVersion: function(appId, versionId, ownerId, callback) {
					return client.query(SQL`INSERT INTO versions (id, app, owner) VALUES (${versionId}, ${appId}, ${ownerId})`, function(err, result) {
						if (err) {
							return callback(err, result);
						}

						return client.query(SQL`UPDATE apps SET latest=${versionId} WHERE id=${appId}`, callback);
					});
				},
				deleteVersion: function(appId, versionId, callback) {
					return client.query(SQL`DELETE FROM versions WHERE app=${appId} AND id=${versionId}`, callback);
				},
				replaceVersion: function(appId, previousVersionId, newVersionId, callback) {
					return client.query(SQL`UPDATE apps SET current=${newVersionId}, previous=${previousVersionId} WHERE id=${appId}`, callback);
				},

				// Slack
				updateSlackAuthorization: function(token, callback) {
					// XXX: token.expires, token.token_type missing? Slack doesn't document these, but they should be there for OAuth 2.0 reasons.
					return client.query(SQL`INSERT INTO slack (teamid, accesstoken, scope, botid, botaccesstoken)
						VALUES (${token.team_id}, ${token.access_token}, ${token.scope}, ${token.bot.bot_user_id}, ${token.bot.bot_access_token}})
						ON CONFLICT (teamid) DO
						UPDATE SET accesstoken=EXCLUDED.accesstoken, SET scope=EXCLUDED.scope, SET botid=EXCLUDED.botid, SET botaccesstoken=EXCLUDED.botaccesstoken`, callback);
				},

				// Caching
				cachedQueryApp: function(appId, callback) {
					return _cachedQuery(applicationCache, this.queryApp, appId, callback);
				},
				cachedQueryVersions: function(appId, callback) {
					return _cachedQuery(versionsCache, this.queryVersions, appId, callback);
				},
				cachedQueryVersion: function(appId, versionId, callback) {
					return this.cachedQueryVersions(appId, function(err, result) {
						if (err) {
							return callback(err, result);
						}

						const matchingVersions = result.rows.filter(value => value.id === versionId);
						return callback(null, {
							rows: matchingVersions,
							rowCount: matchingVersions.length
						});
					});
				},
				invalidateCachedApp: function(appId) {
					return _invalidateCachedApp(appId);
				},
				invalidateCachedVersions: function(appId) {
					return _invalidateCachedVersions(appId);
				}
			};

			return next();
		});
	};
}

// See http://stackoverflow.com/a/35651853/196315
var rawBodySaver = function (req, res, buf, encoding) {
	if (buf && buf.length) {
		req.rawBody = buf.toString(encoding || 'utf8');
	}
}
app.use(bodyParser.json({ verify: rawBodySaver }));
app.use(morgan('dev'));
app.use(postgres(app.locals.pg.url));

app.use(function auth(req, res, next) {
	req.challenge = req.get('authorization');

	const bearer = req.challenge && req.challenge.match(/^Bearer\s+(.+)$/);
	if (bearer) {
		return jwt.verify(bearer[1], req.app.locals.jwt.key, { issuer: req.app.locals.jwt.issuer }, function(err, token) {
			if (err) {
				console.log(err);
				return res.status(403).send();
			}

			return req.db.queryUser(token.sub, function(err, result) {
				if (err) {
					return next(err);
				}

				if (result.rowCount !== 1) {
					return res.status(403).send();
				}

				req.authenticated = true;
				req.user = result.rows[0];
				return next();
			})
		});
	} else {
		return next();
	}
});

// Lock down the application a bit
app.use(helmet.frameguard());
app.use(helmet.hidePoweredBy());
app.use(helmet.hsts({
	setIf: function(req, res) {
		return req.secure && process.env.NODE_ENV === 'production';
	}
}));
app.use(helmet.ieNoOpen());
app.use(helmet.noSniff());
app.use(helmet.xssFilter());

function applicationParam(req, res, next, id) {
	return req.db.cachedQueryApp(id, function(err, result) {
		if (err) {
			return next(err);
		}

		if (result.rowCount !== 1) {
			// No such app.
			return res.status(404).send();
		}

		req.application = result.rows[0];
		return next();
	});
};

function versionParam(req, res, next, version) {
	// version could be an existing directory reference (usually a git revision hash), or it is
	// a symbolic name:
	// - 'current': whatever we defined in our database as 'current' for this app
	// - 'previous': whatever was defined in our database as 'previous' (quick rollback support)
	// Note that we have req.application available here already.
	var resolvedVersion;
	switch (version) {
		case 'current':
			resolvedVersion = req.application.current;
			break;
		case 'previous':
			resolvedVersion = req.application.previous;
			break;
		case 'latest':
			resolvedVersion = req.application.latest;
			break;
		default:
			resolvedVersion = version;
			break;
	}

	if (!resolvedVersion) {
		return res.status(404).send();
	}

	// Validate that that version exists
	return req.db.cachedQueryVersion(req.application.id, resolvedVersion, function(err, result) {
		if (err) {
			console.log(err);
			return res.status(500).send({ error: err.message });
		}
		if (result.rowCount !== 1) {
			return res.status(404).send();
		}

		req.version = resolvedVersion;
		return next();
	});
};

const uiRouter = express.Router();
uiRouter.get('/login', function(req, res) {
	return res.redirect(`https://github.com/login/oauth/authorize?scope=user:email&client_id=${req.app.locals.github.clientId}`);
});

uiRouter.get('/*?', function(req, res) {
	const file = req.params[0] || 'index.html';
	return res.sendFile(path.resolve(__dirname, req.app.locals.cfp.appDir, file));
});

const appRouter = express.Router();
appRouter.param('application', applicationParam);
appRouter.param('version', versionParam);
appRouter.get('/:application/:version/*?', function(req, res) {
	// XXX: anything we should do to the path?
	const file = req.params[0] || 'index.html';
	const params = {
		Bucket: req.app.locals.s3.bucket,
		Key: `${req.application.id}/${req.version}/${file}`,
		// Copy over some headers
		IfMatch: req.get('if-match'),
		IfModifiedSince: new Date(req.get('if-modified-since')),
		IfNoneMatch: req.get('if-none-match'),
		IfUnmodifiedSince: new Date(req.get('if-unmodified-since'))
	};

	s3.getObject(params, function(err, data) {
		if (err) {
			switch (err.code) {
				case 'AccessDenied':
					res.status(403);
					break;
				case 'NotModified':
					// Perfectly fine: just set the status and send the answer.
					res.status(304);
					break;
				default:
					console.log(err);
					res.status(500).send({ error: err.message });
					break;
			}
			return res.send();
		}

		// Build the headers.
		// Note that express will send 'undefined' if there is something undefined here, so we need to filter these
		// out ourselves.
		const headers = {
			'last-modified': data.LastModified,
			'etag': data.ETag,
			'cache-control': data.CacheControl,
			'expires': data.Expires,
			'content-disposition': data.ContentDisposition,
			'content-encoding': data.ContentEncoding,
			'content-language': data.ContentLanguage,
			'content-type': data.ContentType
		};

		Object.keys(headers).forEach(key => {
			const value = headers[key];
			if (value) {
				res.set(key, headers[key]);
			}
		});

		return res
			.status(200)
			.send(data.Body);
	})
});

const apiRouter = express.Router();
apiRouter.param('application', applicationParam);
apiRouter.param('version', versionParam);
apiRouter.get('/apps', function(req, res) {
	return req.db.queryApps(function(err, result) {
		if (err) {
			console.log(err);
			return res.status(500).send({ error: err.message });
		}

		return res.status(200).send(result.rows);
	});
});

apiRouter.get('/app/:application', function(req, res) {
	return req.db.queryApp(req.application.id, function(err, result) {
		if (err) {
			console.log(err);
			return res.status(500).send({ error: err.message });
		}

		if (result.rowCount !== 1) {
			return res.status(404).send();
		}

		return res.status(200).send(result.rows[0]);
	});
});

apiRouter.put('/app/:newApplication', function(req, res) {
	return req.db.createApp(req.params.newApplication, req.user.id, function(err, result) {
		if (err) {
			return res.status(400).send({ error: err.message });
		}

		// TODO: Validate that we have a branch of that one?
		return res.status(201).json({
			id: req.params.newApp,
			owner: req.user.id
		});
	});
});

apiRouter.delete('/app/:application', function(req, res) {
	return req.db.deleteApp(req.application.id, function(err, result) {
		if (err) {
			return res.status(400).send({ error: err.message });
		}

		req.db.invalidateCachedApp(req.application.id);
		req.db.invalidateCachedVersions(req.application.id);

		return res.status(204).send();
	});
});

apiRouter.get('/app/:application/versions', function(req, res) {
	return req.db.queryVersions(req.application.id, function(err, result) {
		if (err) {
			console.log(err);
			return res.status(500).send({ error: err.message });
		}

		return res.status(200).send(result.rows);
	});
});
apiRouter.get('/app/:application/version/:version', function(req, res) {
	return req.db.queryVersion(req.application.id, req.version, function(err, result) {
		if (err) {
			console.log(err);
			return res.status(500).send({ error: err.message });
		}

		if (result.rowCount !== 1) {
			return res.status(404).send();
		}

		return res.status(200).send(result.rows[0]);
	});
});

apiRouter.put('/app/:application/version/:newVersion', function(req, res) {
	return req.db.createVersion(req.application.id, req.params.newVersion, req.user.id, function(err, result) {
		if (err) {
			console.log(err);
			return res.status(500).send({ error: err.message });
		}

		req.db.invalidateCachedVersions(req.application.id);

		const response = {
			id: req.params.newVersion,
			app: req.application.id
		};
		if (req.application.autoupdate) {
			req.db.replaceVersion(req.application.id, req.application.current, req.params.newVersion, function(err, result) {
				if (err) {
					console.log(err);
					return res.status(500).send({ error: err.message });
				}

				return res.status(201).send(response);
			});
		} else {
			return res.status(201).send(response);
		}
	});
});
apiRouter.delete('/app/:application/version/:fullVersion', function(req, res) {
	return req.db.deleteVersion(req.application.id, req.params.fullVersion, function(err, result) {
		if (err) {
			console.log(err);
			return res.status(500).send({ error: err.message });
		}

		// XXX: We could just splice out this specific one?
		req.db.invalidateCachedVersions(req.application.id);

		return res.status(204).send();
	});
});
apiRouter.post('/app/:application/version/:version/current', function(req, res) {
	if (req.version === req.application.current) {
		// XXX: Is this really an error, or should we just silently accept it?
		return res.status(400).send({ error: `${req.version} is already current` });
	}

	return req.db.replaceVersion(req.application.id, req.application.current, req.version, function(err, result) {
		if (err) {
			console.log(err);
			return res.status(500).send({ error: err.message });
		}

		req.db.invalidateCachedApp(req.application.id);

		// Return the new state
		return res.status(202).send(Object.assign({}, req.application, {
			current: req.version,
			previous: req.application.current
		}));
	});
});

function handleOAuthCallback(tokenUrl, clientId, clientSecret, code, callback) {
	const accessTokenRequest = {
		uri: tokenUrl,
		qs: {
			client_id: clientId,
			client_secret: clientSecret,
			code: code,
			accept: 'json'
		},
		useQuerystring: true,
		json: true
	};
	return request.post(accessTokenRequest, function(err, response, token) {
		return callback(err, token);
	});	
}

const githubRouter = express.Router();
// Callback for GitHub logins
// Note that we reject any user here that is not in the Collaborne organization; maybe this should be done better.
githubRouter.get('/oauth', function(req, res) {
	return handleOAuthCallback('https://github.com/login/oauth/access_token/', req.app.locals.github.clientId, req.app.locals.github.clientSecret, req.query.code, function(err, token) {
		if (err) {
			console.log(`Callback error: ${err}: ${JSON.stringify(token)}`);
			return res.status(403).send();
		}

		// query the github api for the user id
		const userRequest = {
			uri: 'https://api.github.com/user',
			headers: {
				'authorization': `token ${token.access_token}`,
				'user-agent': 'Collaborne/collaborne-frontend-proxy'
			},
			json: true,
		};
		request.get(userRequest, function(err, response, user) {
			if (err) {
				console.log(`User error: ${err}: ${JSON.stringify(user)}`);
				return res.status(403).send();
			}

			// Ok, we have a user login, issue a JWT for this user.
			// We're only going to actually validate whether the user is *authorized* to use the app when they query
			// the API.
			jwt.sign({ sub: user.login, avatar: user.avatar_url, home: user.html_url }, req.app.locals.jwt.key, { issuer: req.app.locals.jwt.issuer }, function(err, token) {
				if (err) {
					return res.status(403).send();
				}

				return res.cookie('token', token).redirect('/ui/');
			});
		});
	});
});

function validateGitHubSignature(req, res, next) {
	// Validate the signature if we have a key. The assumption is that this key is configured in GitHub as well.
	if (!req.app.locals.github.webhookSecret) {
		return next();
	}

	const hmac = crypto.createHmac('sha1', req.app.locals.github.webhookSecret);
	hmac.setEncoding('hex');
	hmac.end(req.rawBody, function() {
		const signature = 'sha1=' + hmac.read();
		const expectedSignature = req.get('X-Hub-Signature');
		if (!expectedSignature) {
			// Missing signature, likely misconfigured in GitHub.
			// Still: reject the request.
			return res.status(400).error({ error: 'Missing GitHub signature'} );
		}

		if (expectedSignature !== signature) {
			console.log(`Expected: ${expectedSignature}, actual: ${signature}`);
			return res.status(400).error({ error: 'Wrong GitHub signature' });
		}

		// All good, proceed.
		return next();
	});
}

githubRouter.post('/event', validateGitHubSignature, function(req, res) {
	const event = req.get('X-GitHub-Event');
	switch (event) {
		case 'ping':
			// We're cool, hi github!
			return res.status(200).send();
		case 'pull_request':
			// Check what exactly happened, and react.
			// See https://developer.github.com/v3/activity/events/types/#pullrequestevent
			// Note that we're not actively doing anything when the PR is updated - we rely on the build system to deploy & register
			// a new version with us.
			// There is an interesting aspect here: Travis produces merge builds of the PR, but we need to get it to deploy to the PR revision?
			// Alternatively we may have to produce multiple builds of just the branch head, and/or allow branch builds
			// Ideas:
			// - handle 'labeled'/'unlabeled', and copy the labels
			// - handle 'assigned'/'unassigned', and show the assignee
			const pr = body.pull_request;
			switch (req.body.action) {
				case 'opened':
					// New PR, create the app with the owner
					console.log(`New PR#${pr.number} from ${pr.user.login}: ${pr.head.label} (${pr.head.ref}) into ${pr.base.label} (${pr.base.ref})`);
					break;
				case 'closed':
					// PR closed, check 'merged' whether it was good/bad; in any case close the experiment by removing it.
					// XXX: Also remove the previously deployed versions? That would require write access to the S3 repository.
					console.log(`Closed PR##${pr.number} from ${pr.user.login}: ${pr.head.label} (${pr.head.ref}) into ${pr.base.label} (${pr.base.ref}): ${pr.merged}`);
					break;
			}
			return res.status(200).send();
		case 'create':
			if (req.body.ref_type === 'branch') {
				// New branch, register a new app with the owner
				const owner = req.body.sender.login;
				console.log(`New branch ${req.body.ref} by ${owner}`);
				return req.db.createApp(req.body.ref, owner, true, function(err, result) {
					if (err) {
						console.log(err);
						return res.status(500).send({ error: err.message });
					}
					return res.status(200).send();
				});
			}
			return res.status(200).send();
		case 'delete':
			if (req.body.ref_type === 'branch') {
				// Branch removed, remove the associated app and versions
				return req.db.deleteApp(req.body.ref, function(err, result) {
					if (err) {
						console.log(err);
						return res.status(500).send({ error: err.message });
					}

					return res.status(200).send();
				});
			}
			return res.status(200).send();
		case 'status':
			// TODO: Eventually monitor these updates, and potentially update our state
			return res.status(200).send();
		default:
			console.log(`Received unexpected event ${event} from github: ${JSON.stringify(req.body)}`);
			return res.status(505).send();
	}
});

const slackRouter = express.Router();
slackRouter.get('/oauth', function(req, res) {
	return handleOAuthCallback('https://slack.com/api/oauth.access', req.app.locals.slack.clientId, req.app.locals.slack.clientSecret, req.query.code, function(err, token) {
		if (err) {
			console.log(`Callback error: ${err}: ${JSON.stringify(token)}`);
			return res.status(403).send();
		}

		req.db.updateSlackAuthorization(token, function(err, result) {
			if (err) {
				return res.status(500).send({ error: err.message });
			}
			
			return res.status(200).send();
		});
	});
});

app.use('/ui', uiRouter);
app.use('/app', appRouter);
app.use('/api', authentication.required(), apiRouter);
app.use('/github', githubRouter);

app.get('/', function(req, res) {
	return res.redirect('/ui/');
});

app.listen(app.get('port'), function() {
	console.log('Node app is running on port', app.get('port'));
});


