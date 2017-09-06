'use strict';

const path = require('path');

const gulp = require('gulp');

const gulpmatch = require('gulp-match');

const gBabel = require('gulp-babel');
const gCrisper = require('gulp-crisper');
const gDebug = require('gulp-debug');
const gIf = require('gulp-if');
const gSourcemaps = require('gulp-sourcemaps');
const gUglify = require('gulp-uglify');
const gUtil = require('gulp-util');

const del = require('del');
const merge = require('merge-stream');
const through = require('through2');
const runSequence = require('run-sequence');

const argv = require('yargs')
		.boolean('release')
		.argv;

function dist(dir) {
	return dir ? path.join('dist', dir) : 'dist';
}
 
gulp.task('heroku:app.json', function() {
	function appJson() {
		return through.obj(function(file, enc, cb) {
			if (file.isNull() || file.isStream() || file.isDirectory()) {
				return cb(new Error('Require package.json'));
			}

			const pkg = JSON.parse(file.contents);
			const app = {
				name: pkg.name,
				description: pkg.description,
				repository: pkg.repository.url
			};
			
			file.path = 'app.json';
			file.contents = new Buffer(JSON.stringify(app, null, '\t'));
			cb(null, file);
		});
	}

	return gulp.src('package.json')
		.pipe(appJson())
		.pipe(gulp.dest('.'));
});

gulp.task('clean', function() {
	return del([dist()]);
});

gulp.task('copy', function() {
	const bower = gulp.src('app/bower_components/**/*', { base: 'app' });
	const app = gulp.src(['app/**/*', '!app/bower_components/**/*' ], { base: 'app' })
		.pipe(gSourcemaps.init({ loadMaps: true }))
		.pipe(gIf(file => gulpmatch(file, '*.html') && file.relative !== 'index.html', gCrisper({ scriptInHead:false })))
		.pipe(gIf('*.js', argv.release ? gBabel({
			presets: ['es2015-script'],
			compact: true
		}) : gUtil.noop()))
		.pipe(gIf('*.js', argv.release ? gUglify() : gUtil.noop()))
		.pipe(gSourcemaps.write('.'));
	return merge(bower, app)
		.pipe(gulp.dest(dist()));
});

gulp.task('default', [ 'clean' ], function(cb) {
	runSequence(['heroku:app.json', 'copy'], cb);
});

