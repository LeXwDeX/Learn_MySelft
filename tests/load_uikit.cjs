/* Load the production UI Kit into a browser-like VM context. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
module.exports = function loadUIKit(context) {
  if (!context.document) context.document = {addEventListener() {}};
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/ui.js'), 'utf8'), context);
};
