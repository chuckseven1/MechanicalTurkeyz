import { promises as fs } from 'fs';

import Bluebird from 'bluebird';
import rev from 'git-rev';

import gulp from 'gulp';
import ts from 'gulp-typescript';
import typedoc from 'gulp-typedoc';
import rename from 'gulp-rename';
import zip from 'gulp-zip';
// @ts-ignore
import clean from 'gulp-clean';

const tsProject = ts.createProject('tsconfig.json');

gulp.task('clean', function () {
  return gulp.src('dist', { read: false, allowEmpty: true }).pipe(clean());
});

const gitRevision = Bluebird.fromCallback<string>((done) =>
  rev.long((long) => done(null, long))
);

gulp.task(
  'build',
  gulp.series('clean', async function () {
    return Bluebird.all([
      tsProject
        .src()
        .pipe(tsProject())
        .js.on('error', console.log)
        .pipe(gulp.dest('dist')),

      tsProject
        .src()
        .pipe(typedoc({ gitRevision: await gitRevision, out: 'dist/docs' })),

      gulp.src('partials/*.html').pipe(gulp.dest('dist/partials')),

      gulp.src('module.json').pipe(gulp.dest('dist')),

      gulp.src('LICENSE').pipe(gulp.dest('dist')),

      //gulp.src('README.md').pipe(gulp.dest('dist'))
    ]);
  })
);

gulp.task('release', async function () {
  const { id, version } = JSON.parse(
      (await fs.readFile('module.json')).toString()
    ),
    zipFileName = `${id}-v${version}.zip`;

  console.log(`Packaging ${zipFileName}`);

  return gulp
    .src('dist/**/*', { base: 'dist/' })
    .pipe(rename((path) => (path.dirname = `${id}/${path.dirname}`)))
    .pipe(zip(zipFileName))
    .pipe(gulp.dest('.'));
});

gulp.task('default', gulp.series('build', 'release'));
