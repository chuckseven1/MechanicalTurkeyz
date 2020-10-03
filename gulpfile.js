const fs = require('fs'),
  gulp = require('gulp'),
  ts = require('gulp-typescript'),
  clean = require('gulp-clean'),
  rename = require('gulp-rename'),
  zip = require('gulp-zip');

const tsProject = ts.createProject('tsconfig.json');

gulp.task('clean', function () {
  return gulp.src('dist', { read: false }).pipe(clean());
});

gulp.task(
  'build',
  gulp.series('clean', function () {
    return Promise.all([
      tsProject
        .src()
        .pipe(tsProject())
        .js.on('error', console.log)
        .pipe(gulp.dest('dist')),

      gulp.src('partials/*.html').pipe(gulp.dest('dist/partials')),

      gulp.src('module.json').pipe(gulp.dest('dist')),

      gulp.src('LICENSE').pipe(gulp.dest('dist')),

      //gulp.src('README.md').pipe(gulp.dest('dist'))
    ]);
  })
);

gulp.task('release', function () {
  let moduleInfo = JSON.parse(fs.readFileSync('module.json')),
    moduleId = moduleInfo.id,
    moduleVersion = moduleInfo.version,
    zipFileName = `${moduleId}-v${moduleVersion}.zip`;

  console.log(`Packaging ${zipFileName}`);

  return gulp
    .src('dist/**/*', { base: 'dist/' })
    .pipe(rename((path) => (path.dirname = `${moduleId}/${path.dirname}`)))
    .pipe(zip(zipFileName))
    .pipe(gulp.dest('.'));
});

gulp.task('default', gulp.series('build', 'release'));
