/* Local module container. Registration order never determines execution order. */
function createModuleContainer() {
  'use strict';
  var definitions = Object.create(null), instances = Object.create(null), active = [];
  function define(id, dependencies, factory) {
    if (definitions[id]) throw new Error('Duplicate module: ' + id);
    if (!Array.isArray(dependencies) || typeof factory !== 'function') throw new Error('Invalid module: ' + id);
    definitions[id] = {dependencies: dependencies.slice(), factory: factory};
  }
  function requireModule(id) {
    if (Object.prototype.hasOwnProperty.call(instances, id)) return instances[id];
    var definition = definitions[id];
    if (!definition) throw new Error('Missing module: ' + id);
    if (active.indexOf(id) >= 0) throw new Error('Circular dependency: ' + active.concat(id).join(' -> '));
    active.push(id);
    try {
      var dependencies = Object.create(null);
      definition.dependencies.forEach(function (name) { dependencies[name] = requireModule(name); });
      var instance = definition.factory(Object.freeze(dependencies));
      if (!instance || typeof instance !== 'object') throw new Error('Invalid module interface: ' + id);
      instances[id] = Object.freeze(instance);
      return instances[id];
    } finally { active.pop(); }
  }
  return Object.freeze({define: define, get: requireModule});
}
