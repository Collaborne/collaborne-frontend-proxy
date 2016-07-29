'use strict';

const path = require('path');

const gulp = require('gulp');
const util = require('gulp-util');

const del = require('del');
const merge = require('merge-stream');
const through = require('through2');
const runSequence = require('run-sequence');

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
			file.contents = new Buffer(JSON.stringify(app));
			cb(null, file);
		});
	}

	return gulp.src('package.json')
		.pipe(appJson())
		.pipe(gulp.dest(dist()));
});

gulp.task('clean', function() {
	return del([dist()]);
});

gulp.task('copy', function() {
	return gulp.src('app/**/*', { base: 'app' }).pipe(gulp.dest(dist()));
});

gulp.task('default', [ 'clean' ], function(cb) {
	runSequence(['heroku:app.json', 'copy'], cb);
});

