// simple way to add an unparsed handlebars tag to the final template
// ex: {{hb 'name'}}
// results in:
// {{name}}
module.exports = function (content) {
  return '{{' + content + '}}'
}
