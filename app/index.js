'use strict';

const fs = require('fs');
const path = require('path');
const pg = require('pg');
const request = require('request');
const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const express = require('express');
const bodyParser = require('body-parser');
const authentication = require('express-authentication');
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

const s3 = new AWS.S3();

// See https://github.com/brianc/node-postgres/wiki/Prepared-Statements
function SQL(parts, ...values) {
	return {
		text: parts.reduce((prev, curr, i) => `${prev}$${i}${curr}`),
		values
	};
}

// Establish a connection to the DB
if (process.env.NODE_ENV === 'production') {
	pg.defaults.ssl = true;
}

// TODO: Use a pool (https://github.com/brianc/node-postgres#client-pooling)
pg.connect(app.locals.pg.url, function(err, client) {
	if (err) {
		console.log(`Cannot connect to ${app.locals.pg.url}: ${err}`);
		throw err;
	}

	// CRUD operations
	function queryUser(userId, callback) {
		return client.query(SQL`SELECT * FROM users WHERE id=${userId}`, callback);
	}
	function queryApps(callback) {
		return client.query(SQL`SELECT * FROM apps`, callback);
	}	
	function queryApp(appId, callback) {
		return client.query(SQL`SELECT * FROM apps WHERE id=${appId}`, callback);
	}
	function createApp(appId, ownerId, callback) {
		return client.query(SQL`INSERT INTO apps (id, owner) VALUES (${appId}, ${ownerId})`, callback);
	}
	function deleteApp(appId, callback) {
		return client.query(SQL`DELETE FROM apps WHERE id=${appId}`, callback);
	}	
	function queryVersions(appId, callback) {
		return client.query(SQL`SELECT * FROM versions WHERE app=${appId} ORDER BY row_number() OVER () DESC`, callback);
	}
	function queryVersion(appId, versionId, callback) {
		return client.query(SQL`SELECT * FROM versions WHERE app=${appId} AND id=${versionId}`, callback);
	}
	function createVersion(appId, versionId, callback) {
		return client.query(SQL`INSERT INTO versions (id, app) VALUES (${versionId}, ${appId})`, callback);
	}
	function deleteVersion(appId, versionId, callback) {
		return client.query(SQL`DELETE FROM versions WHERE app=${appId} AND id=${versionId}`, callback);
	}
	function replaceVersion(appId, previousVersionId, newVersionId, callback) {
		return client.query(SQL`UPDATE apps SET current=${newVersionId}, previous=${previousVersionId} WHERE id=${appId}`, callback);
	}

	app.set('port', (process.env.PORT || 5000));

	// See http://stackoverflow.com/a/35651853/196315
	var rawBodySaver = function (req, res, buf, encoding) {
		if (buf && buf.length) {
			req.rawBody = buf.toString(encoding || 'utf8');
		}
	}
	app.use(bodyParser.json({ verify: rawBodySaver }));
	app.use(morgan('dev'));
	app.use(function auth(req, res, next) {
		req.challenge = req.get('authorization');

		const bearer = req.challenge && req.challenge.match(/^Bearer\s+(.+)$/);
		if (bearer) {
			return jwt.verify(bearer[1], req.app.locals.jwt.key, { issuer: req.app.locals.jwt.issuer }, function(err, token) {
				if (err) {
					console.log(err);
					return res.status(403).send();
				}

				queryUser(token.sub, function(err, result) {
					if (err) {
						return next(err);
					}

					if (result.rowCount !== 1) {
						return res.status(403).send();
					}

					req.authenticated = true;
					req.user = result.rows[0];
					next();
				})
			});
		} else {
			return next();
		}
	});

	app.param('application', function(req, res, next, id) {
		queryApp(id, function(err, result) {
			if (err) {
				return next(err);
			}

			if (result.rowCount !== 1) {
				// No such app.
				return res.status(404).send();
			}

			req.application = result.rows[0];
			next();
		});
	});

	app.param('version', function(req, res, next, version) {
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
			default:
				resolvedVersion = version;
				break;
		}

		if (!resolvedVersion) {
			return res.status(404).send();
		}

		// Validate that that version exists
		queryVersion(req.application.id, resolvedVersion, function(err, result) {
			if (err) {
				return res.status(500).send({ error: err.message });
			}
			if (result.rowCount !== 1) {
				return res.status(404).send();
			}

			req.version = resolvedVersion;
			next();
		});
	});

	app.get('/', function(req, res) {
		return res.redirect('/ui/');
	});

	app.get('/ui/login', function(req, res) {
		return res.redirect(`https://github.com/login/oauth/authorize?scope=user:email&client_id=${req.app.locals.github.clientId}`);
	});

	app.get('/ui/*?', function(req, res) {
		const file = req.params[0] || 'index.html';
		return res.sendFile(path.join(__dirname, file));
	});

	app.get('/app/:application/:version/*?', function(req, res) {
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

	app.get('/api/apps', authentication.required(), function(req, res) {
		queryApps(function(err, result) {
			if (err) {
				console.log(err);
				return res.status(500).send({ error: err.message });
			}

			return res.status(200).send(result.rows);
		});
	});

	app.get('/api/app/:application', authentication.required(), function(req, res) {
		queryApp(req.application.id, function(err, result) {
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

	app.put('/api/app/:newApplication', authentication.required(), function(req, res) {
		if (!req.body.owner) {
			return res.status(400).send({ error: 'owner required' });
		}

		createApp(req.params.newApplication, req.body.owner, function(err, result) {
			if (err) {
				return res.status(400).send({ error: err.message });
			}

			// TODO: Validate that we have a branch of that one?
			return res.status(201).json({
				id: req.params.newApp,
				owner: req.body.owner
			});
		});
	});

	app.delete('/api/app/:application', authentication.required(), function(req, res) {
		deleteApp(req.application.id, function(err, result) {
			if (err) {
				return res.status(400).send({ error: err.message });
			}

			return res.status(204).send();
		});
	});

	app.get('/api/app/:application/versions', authentication.required(), function(req, res) {
		queryVersions(req.application.id, function(err, result) {
			if (err) {
				return res.status(500).send({ error: err.message });
			}

			return res.status(200).send(result.rows);
		});
	});
	app.get('/api/app/:application/version/:version', authentication.required(), function(req, res) {
		queryVersion(req.application.id, req.version, function(err, result) {
			if (err) {
				return res.status(500).send({ error: err.message });
			}

			if (result.rowCount !== 1) {
				return res.status(404).send();
			}

			return res.status(200).send(result.rows[0]);
		});
	});

	app.put('/api/app/:application/version/:newVersion', authentication.required(), function(req, res) {
		createVersion(req.applicationId, req.params.newVersion, function(err, result) {
			if (err) {
				return res.status(500).send({ error: err.message });
			}

			const response = {
				id: req.params.newVersion,
				app: req.application.id
			};
			if (req.application.autoupdate) {
				replaceVersion(req.application.id, req.application.current, req.params.version, function(err, result) {
					if (err) {
						return res.status(500).send({ error: err.message });
					}

					return res.status(201).send(response);					
				});				
			} else {
				return res.status(201).send(response);
			}
		});
	});
	app.delete('/api/app/:application/version/:fullVersion', authentication.required(), function(req, res) {
		deleteVersion(req.application.id, req.params.fullVersion, function(err, result) {
			if (err) {
				return res.status(500).send({ error: err.message });
			}

			return res.status(204).send();
		});
	});
	app.post('/api/app/:application/version/:version/current', authentication.required(), function(req, res) {
		if (req.version === req.application.current) {
			// XXX: Is this really an error, or should we just silently accept it?
			return res.status(400).send({ error: `${req.version} is already current` });
		}
		
		replaceVersion(req.application.id, req.application.current, req.version, function(err, result) {
			if (err) {
				return res.status(500).send({ error: err.message });
			}

			// Return the new state
			return res.status(202).send({
				id: req.application.id,
				current: req.version,
				previous: req.application.current
			});
		});
	});

	// Callback for GitHub logins
	// Note that we reject any user here that is not in the Collaborne organization; maybe this should be done better.
	app.get('/github/oauth', function(req, res) {
		const accessTokenRequest = {
			uri: 'https://github.com/login/oauth/access_token/',
			qs: {
				client_id: req.app.locals.github.clientId,
				client_secret: req.app.locals.github.clientSecret,
				code: req.query.code,
				accept: 'json'
			},
			useQuerystring: true,
			json: true
		};
		request.post(accessTokenRequest, function(err, response, token) {
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

	app.post('/github/event', validateGitHubSignature, function(req, res) {
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
					return createApp(req.body.ref, owner, function(err, result) {
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

	app.listen(app.get('port'), function() {
		console.log('Node app is running on port', app.get('port'));
	});
});


