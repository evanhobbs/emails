var Handlebars = require('handlebars')
var through = require('through2')
var path = require('path')

// mandrill has it's own custom handlebars helpers - simulating them here so we can
// do a pretend compile locally
var mandrillHandlebarsHelpers = {
  if: function (statement, options) {
    var result = (function (data) {
      // make all the attributes for data local variables for eval
      Object.keys(data).forEach(function (key) {
        return this[key] = data[key]
      })
      return eval(statement)
    }(this))

    if (result) return options.fn(this)
    else return options.inverse(this)
  }
}

Handlebars.registerHelper(mandrillHandlebarsHelpers)

module.exports = function () {
  // returns a gulp plugin
  return through.obj(function (file, encoding, callback) {
    var templateData = require('./src/fixtures/' + path.basename(file.path, '.html'))
    var html = file.contents.toString()
    // the first panini compile html escapes all the " and ' in hb tags so convert them
    // back before recompiling
    html = html.replace(/\{\{.*?\}\}/g, function (match) {
      return match.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    })

    // mandrill custom #if helper uses backticks for comparison expressions, eg {{#if `accounts.length === 1`}}
    // but our fake implementation dies on this so convert them to ' before compiling
    html = html.replace(/({{#if)\s*?(`)([^`]*)(`)\s*?(}})/g, '$1 \'$3\' $5')
    var template = Handlebars.compile(html)
    file.contents = new Buffer(template(templateData))
    callback(null, file)
  })
}
