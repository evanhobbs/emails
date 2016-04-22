var gulp = require('gulp')
var plugins = require('gulp-load-plugins')
var browser = require('browser-sync')
var rimraf = require('rimraf')
var panini = require('panini')
var yargs = require('yargs')
var lazypipe = require('lazypipe')
var inky = require('inky')
var fs = require('fs')
var siphon = require('siphon-media-query')
var path = require('path')
var merge = require('merge-stream')
var Mandrill = require('mandrill-api').Mandrill
const $ = plugins()

// Look for the --production flag
var PRODUCTION = !!(yargs.argv.production)
// used for processes that need to enforce production
function setProduction(done) {
  PRODUCTION = true
  done()
}

const CONFIG = JSON.parse(fs.readFileSync('./config.json'))

const awsURL = !!CONFIG && !!CONFIG.aws && !!CONFIG.aws.url ? CONFIG.aws.url : false
const mandrill_client = new Mandrill(CONFIG.mandrill_key)

// Build the "dist" folder by running all of the above tasks
gulp.task('build',
  gulp.series(clean, pages, sass, images, inline, preview))

// Build emails, run the server, and watch for file changes
gulp.task('default',
  gulp.series('build', server, watch))

// Build emails, then send to litmus
gulp.task('litmus',
  gulp.series('build', aws, litmus))

// Build emails, then zip
gulp.task('zip',
  gulp.series('build', zip))

gulp.task('updateMandrill', gulp.series(setProduction, 'build', aws, updateMandrill))

function preview (done) {
  return gulp.src('preview/**/*')
    .pipe(gulp.dest('./dist'))
}

// Delete the "dist" folder
// This happens every time a build starts
function clean (done) {
  rimraf('dist', done)
}

// Compile layouts, pages, and partials into flat HTML files
// Then parse using Inky templates
function pages () {
  return gulp.src('src/pages/**/*.html')
    .pipe(panini({
      root: 'src/pages',
      layouts: 'src/layouts',
      partials: 'src/partials',
      helpers: 'src/helpers'
    }))
    .pipe(inky())
    .pipe(gulp.dest('dist'))
}

// Reset Panini's cache of layouts and partials
function resetPages (done) {
  panini.refresh()
  done()
}

// Compile Sass into CSS
function sass () {
  return gulp.src('src/assets/scss/app.scss')
    .pipe($.if(!PRODUCTION, $.sourcemaps.init()))
    .pipe($.sass({
      includePaths: ['node_modules/foundation-emails/scss']
    }).on('error', $.sass.logError))
    .pipe($.if(!PRODUCTION, $.sourcemaps.write()))
    .pipe(gulp.dest('dist/css'))
}

// Copy and compress images
function images () {
  return gulp.src('src/assets/img/*')
    .pipe($.imagemin())
    .pipe(gulp.dest('./dist/assets/img'))
}

// Inline CSS and minify HTML
function inline () {
  return gulp.src('dist/**/*.html')
    .pipe($.if(PRODUCTION, inliner('dist/css/app.css')))
    .pipe(gulp.dest('dist'))
}

// Start a server with LiveReload to preview the site in
function server (done) {
  browser.init({
    server: 'dist'
  })
  done()
}

// Watch for file changes
function watch () {
  gulp.watch('src/pages/**/*.html', gulp.series(pages, inline, browser.reload))
  gulp.watch(['src/layouts/**/*', 'src/partials/**/*'], gulp.series(resetPages, pages, inline, browser.reload))
  gulp.watch(['../scss/**/*.scss', 'src/assets/scss/**/*.scss'], gulp.series(sass, pages, inline, browser.reload))
  gulp.watch('src/assets/img/**/*', gulp.series(images, browser.reload))
}

// Inlines CSS into HTML, adds media query CSS into the <style> tag of the email, and compresses the HTML
function inliner (css) {
  var css = fs.readFileSync(css).toString()
  var mqCss = siphon(css)

  var pipe = lazypipe()
    .pipe($.inlineCss, {
      applyStyleTags: false
    })
    .pipe($.replace, '<!-- <style> -->', `<style>${mqCss}</style>`)
    // .pipe($.htmlmin, {
    //   collapseWhitespace: true,
    //   minifyCSS: true
    // })

  return pipe()
}

// Post images to AWS S3 so they are accessible to Litmus test
function aws () {
  var publisher = !!CONFIG.aws ? $.awspublish.create(CONFIG.aws) : $.awspublish.create()
  var headers = {
    'Cache-Control': 'max-age=315360000, no-transform, public'
  }

  return gulp.src('./dist/assets/img/*')
    // publisher will add Content-Length, Content-Type and headers specified above
    // If not specified it will set x-amz-acl to public-read by default
    .pipe(publisher.publish(headers))

    // create a cache file to speed up consecutive uploads
    // .pipe(publisher.cache())

    // print upload updates to console
    .pipe($.awspublish.reporter())
}

// Send email to Litmus for testing. If no AWS creds then do not replace img urls.
function litmus () {
  // var awsURL = !!CONFIG && !!CONFIG.aws && !!CONFIG.aws.url ? CONFIG.aws.url : false

  return gulp.src(['dist/**/*.html', '!dist/preview.html'])
    .pipe($.if(!!awsURL, $.replace(/=('|")(\/?assets\/img)/g, '=$1' + awsURL)))
    .pipe($.litmus(CONFIG.litmus))
    .pipe(gulp.dest('dist'))
}

function updateMandrill (done) {
  const templateName = yargs.argv.template
  const html = fs.readFileSync('./dist/' + templateName + '.html').toString().replace(/=('|")(\/?assets\/img)/g, '=$1' + awsURL)
  mandrill_client.templates.update({
    'name': templateName,
    'code': html,
    'publish': true
  },
  function (result) {
    result.code = result.publish_code = '[ abridged ]'
    console.log('Mandrill template updated successfully!')
    console.log(result)
    done()
  },
  function (e) {
    throw new Error('A mandrill error occurred: ' + e.name + ' - ' + e.message)
  })
}

// Copy and compress into Zip
function zip () {
  var dist = 'dist'
  var ext = '.html'

  function getHtmlFiles (dir) {
    return fs.readdirSync(dir)
      .filter(function (file) {
        var fileExt = path.join(dir, file)
        var isHtml = path.extname(fileExt) === ext
        return fs.statSync(fileExt).isFile() && isHtml
      })
  }

  var htmlFiles = getHtmlFiles(dist)

  var moveTasks = htmlFiles.map(function (file) {
    var sourcePath = path.join(dist, file)
    var fileName = path.basename(sourcePath, ext)

    var moveHTML = gulp.src(sourcePath)
      .pipe($.rename(function (path) {
        path.dirname = fileName
        return path
      }))

    var moveImages = gulp.src(sourcePath)
      .pipe($.htmlSrc({ selector: 'img' }))
      .pipe($.rename(function (path) {
        path.dirname = fileName + '/assets/img'
        return path
      }))

    return merge(moveHTML, moveImages)
      .pipe($.zip(fileName + '.zip'))
      .pipe(gulp.dest('dist'))
  })

  return merge(moveTasks)
}
