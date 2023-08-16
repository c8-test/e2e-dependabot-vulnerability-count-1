import hoistVariables from "babel-helper-hoist-variables";
import template from "babel-template";

let buildTemplate = template(`
  System.register(MODULE_NAME, [SOURCES], function (EXPORT_IDENTIFIER) {
    BEFORE_BODY;
    return {
      setters: [SETTERS],
      execute: function () {
        BODY;
      }
    };
  });
`);

let buildExportAll = template(`
  for (var KEY in TARGET) {
    if (KEY !== "default") EXPORT_OBJ[KEY] = TARGET[KEY];
  }
`);

export default function ({ types: t }) {
  let IGNORE_REASSIGNMENT_SYMBOL = Symbol();

  let reassignmentVisitor = {
    "AssignmentExpression|UpdateExpression"(path) {
      if (path.node[IGNORE_REASSIGNMENT_SYMBOL]) return;
      path.node[IGNORE_REASSIGNMENT_SYMBOL] = true;

      let arg = path.get(path.isAssignmentExpression() ? "left" : "argument");
      if (!arg.isIdentifier()) return;

      let name = arg.node.name;

      // redeclared in this scope
      if (this.scope.getBinding(name) !== path.scope.getBinding(name)) return;

      let exportedNames = this.exports[name];
      if (!exportedNames) return;

      let node = path.node;

      for (let exportedName of exportedNames) {
        node = this.buildCall(exportedName, node).expression;
      }

      path.replaceWith(node);
    }
  };

  return {
    inherits: require("babel-plugin-transform-strict-mode"),

    visitor: {
      Program: {
        exit(path) {
          let exportIdent = path.scope.generateUidIdentifier("export");

          let exportNames = Object.create(null);
          let modules = Object.create(null);

          let beforeBody = [];
          let setters = [];
          let sources = [];
          let variableIds = [];

          function addExportName(key, val) {
            exportNames[key] = exportNames[key] || [];
            exportNames[key].push(val);
          }

          function pushModule(source, key, specifiers) {
            let _modules = modules[source] = modules[source] || { imports: [], exports: [] };
            _modules[key] = _modules[key].concat(specifiers);
          }

          function buildExportCall(name, val) {
            return t.expressionStatement(
              t.callExpression(exportIdent, [t.stringLiteral(name), val])
            );
          }

          let body: Array<Object> = path.get("body");

          let canHoist = true;
          for (let path of body) {
            if (path.isExportDeclaration()) path = path.get("declaration");
            if (path.isVariableDeclaration() && path.node.kind !== "var") {
              canHoist = false;
              break;
            }
          }

          for (let path of body) {
            if (canHoist && path.isFunctionDeclaration()) {
              beforeBody.push(path.node);
              path.remove();
            } else if (path.isImportDeclaration()) {
              let source = path.node.source.value;
              pushModule(source, "imports", path.node.specifiers);
              for (let name in path.getBindingIdentifiers()) {
                path.scope.removeBinding(name);
                variableIds.push(t.identifier(name));
              }
              path.remove();
            } else if (path.isExportAllDeclaration()) {
              pushModule(path.node.source.value, "exports", path.node);
              path.remove();
            } else if (path.isExportDefaultDeclaration()) {
              let declar = path.get("declaration");
              if (declar.isClassDeclaration() || declar.isFunctionDeclaration()) {
                let id = declar.node.id;
                let nodes = [];

                if (id) {
                  nodes.push(declar.node);
                  nodes.push(buildExportCall("default", id));
                  addExportName(id.name, "default");
                } else {
                  nodes.push(buildExportCall("default", t.toExpression(declar.node)));
                }

                if (!canHoist || declar.isClassDeclaration()) {
                  path.replaceWithMultiple(nodes);
                } else {
                  beforeBody = beforeBody.concat(nodes);
                  path.remove();
                }
              } else {
                path.replaceWith(buildExportCall("default", declar.node));
              }
            } else if (path.isExportNamedDeclaration()) {
              let declar = path.get("declaration");

              if (declar.node) {
                path.replaceWith(declar);

                let nodes = [];
                let bindingIdentifiers;
                if (path.isFunction()) {
                  bindingIdentifiers = { [declar.node.id.name]: declar.node.id };
                } else {
                  bindingIdentifiers = declar.getBindingIdentifiers();
                }
                for (let name in bindingIdentifiers) {
                  addExportName(name, name);
                  nodes.push(buildExportCall(name, t.identifier(name)));
                }
                path.insertAfter(nodes);
              }

              let specifiers = path.node.specifiers;
              if (specifiers && specifiers.length) {
                if (path.node.source) {
                  pushModule(path.node.source.value, "exports", specifiers);
                  path.remove();
                } else {
                  let nodes = [];

                  for (let specifier of specifiers) {
                    nodes.push(buildExportCall(specifier.exported.name, specifier.local));
                    addExportName(specifier.local.name, specifier.exported.name);
                  }

                  path.replaceWithMultiple(nodes);
                }
              }
            }
          }

          for (let source in modules) {
            let specifiers = modules[source];

            let setterBody = [];
            let target = path.scope.generateUidIdentifier(source);

            for (let specifier of specifiers.imports) {
              if (t.isImportNamespaceSpecifier(specifier)) {
                setterBody.push(t.expressionStatement(t.assignmentExpression("=", specifier.local, target)));
              } else if (t.isImportDefaultSpecifier(specifier)) {
                specifier = t.importSpecifier(specifier.local, t.identifier("default"));
              }

              if (t.isImportSpecifier(specifier)) {
                setterBody.push(t.expressionStatement(t.assignmentExpression("=", specifier.local, t.memberExpression(target, specifier.imported))));
              }
            }

            if (specifiers.exports.length) {
              let exportObjRef = path.scope.generateUidIdentifier("exportObj");

              setterBody.push(t.variableDeclaration("var", [
                t.variableDeclarator(exportObjRef, t.objectExpression([]))
              ]));

              for (let node of specifiers.exports) {
                if (t.isExportAllDeclaration(node)) {
                  setterBody.push(buildExportAll({
                    KEY: path.scope.generateUidIdentifier("key"),
                    EXPORT_OBJ: exportObjRef,
                    TARGET: target
                  }));
                } else if (t.isExportSpecifier(node)) {
                  setterBody.push(t.expressionStatement(
                    t.assignmentExpression("=", t.memberExpression(exportObjRef, node.exported), t.memberExpression(target, node.local))
                  ));
                } else {
                  // todo
                }
              }

              setterBody.push(t.expressionStatement(t.callExpression(exportIdent, [exportObjRef])));
            }

            sources.push(t.stringLiteral(source));
            setters.push(t.functionExpression(null, [target], t.blockStatement(setterBody)));
          }


          let moduleName = this.getModuleName();
          if (moduleName) moduleName = t.stringLiteral(moduleName);

          if (canHoist) {
            hoistVariables(path, id => variableIds.push(id));
          }

          if (variableIds.length) {
            beforeBody.unshift(t.variableDeclaration("var", variableIds.map(id => t.variableDeclarator(id))));
          }

          path.traverse(reassignmentVisitor, {
            exports: exportNames,
            buildCall: buildExportCall,
            scope: path.scope
          });

          path.node.body = [
            buildTemplate({
              BEFORE_BODY: beforeBody,
              MODULE_NAME: moduleName,
              SETTERS: setters,
              SOURCES: sources,
              BODY: path.node.body,
              EXPORT_IDENTIFIER: exportIdent
            })
          ];
        }
      }
    }
  };
}
