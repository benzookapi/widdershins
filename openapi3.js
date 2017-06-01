var up = require('url');
var path = require('path');
var util = require('util');

var yaml = require('js-yaml');
var xml = require('jgexml/json2xml.js');
var jptr = require('jgexml/jpath.js');
var circular = require('openapi_optimise/circular.js');
var sampler = require('openapi-sampler');
var dot = require('dot');
dot.templateSettings.strip = false;
dot.templateSettings.varname = 'data';

var common = require('./common.js');

var circles = [];

/**
* function to reformat openapi paths object into an iodocs-style resources object, tags-first
*/
function convertToToc(source) {
	var apiInfo = common.clone(source, false);
	apiInfo.resources = {};
	for (var p in apiInfo.paths) {
		for (var m in apiInfo.paths[p]) {
			if (m != 'parameters') {
				var sMethod = apiInfo.paths[p][m];
				var ioMethod = {};
				ioMethod.path = p;
				ioMethod.op = m;
				var sMethodUniqueName = (sMethod.operationId ? sMethod.operationId : m + '_' + p).split('/').join('_');
				sMethodUniqueName = sMethodUniqueName.split(' ').join('_'); // TODO {, } and : ?
				var tagName = 'Default';
				if (sMethod.tags && sMethod.tags.length > 0) {
					tagName = sMethod.tags[0];
				}
				if (!apiInfo.resources[tagName]) {
					apiInfo.resources[tagName] = {};
					if (apiInfo.tags) {
						for (var t in apiInfo.tags) {
							var tag = apiInfo.tags[t];
							if (tag.name == tagName) {
								apiInfo.resources[tagName].description = tag.description;
								apiInfo.resources[tagName].externalDocs = tag.externalDocs;
							}
						}
					}
				}
				if (!apiInfo.resources[tagName].methods) apiInfo.resources[tagName].methods = {};
				apiInfo.resources[tagName].methods[sMethodUniqueName] = ioMethod;
			}
		}
	}
	delete apiInfo.paths; // to keep size down
	delete apiInfo.definitions; // ditto
	delete apiInfo.components; // ditto
	return apiInfo;
}

function convert(openapi, options, callback) {

	var defaults = {};
	defaults.language_tabs = [{ 'shell': 'Shell' }, { 'http': 'HTTP' }, { 'javascript': 'JavaScript' }, { 'javascript--nodejs': 'Node.JS' }, { 'python': 'Python' }, { 'ruby': 'Ruby' }, { 'java': 'Java' }];
	defaults.codeSamples = true;
	defaults.theme = 'darkula';
	defaults.search = true;
	defaults.sample = true;
	defaults.discovery = false;
	defaults.includes = [];
	defaults.templateCallback = function (templateName, stage, data) { return data; };

	options = Object.assign({}, defaults, options);
	if (!options.codeSamples) options.language_tabs = [];

	var templates = dot.process({ path: path.join(__dirname, 'templates', 'openapi3') });
	if (options.user_templates) {
		templates = Object.assign(templates, dot.process({ path: options.user_templates }));
	}

	var header = {};
	header.title = openapi.info.title + ' ' + ((openapi.info.version && openapi.info.version.toLowerCase().startsWith('v')) ? openapi.info.version : 'v' + (openapi.info.version||'?'));

	// we always show json / yaml / xml if used in content-types
	header.language_tabs = options.language_tabs;

	circles = circular.getCircularRefs(openapi, options);

	header.toc_footers = [];
	if (openapi.externalDocs) {
		if (openapi.externalDocs.url) {
			header.toc_footers.push('<a href="' + openapi.externalDocs.url + '">' + (openapi.externalDocs.description ? openapi.externalDocs.description : 'External Docs') + '</a>');
		}
	}
	header.includes = options.includes;
	header.search = options.search;
	header.highlight_theme = options.theme;

	var data = {};
	data.api = data.openapi = openapi;
	data.header = header;

	var content = '';

	if (openapi.servers && openapi.servers.length) {
		data.servers = openapi.servers;
	}
	else if (options.loadedFrom) {
		data.servers = [{url:options.loadedFrom}];
	}
	else {
		data.servers = [{url:'//'}];
	}

	data.contactName = (openapi.info.contact && openapi.info.contact.name ? openapi.info.contact.name : 'Support');

	data = options.templateCallback('heading_main', 'pre', data);
	if (data.append) { content += data.append; delete data.append; }
	content += templates.heading_main(data) + '\n';
	data = options.templateCallback('heading_main', 'post', data);
	if (data.append) { content += data.append; delete data.append; }

	var securityContainer = (openapi.components && openapi.components.securitySchemes);
	if (securityContainer) {
		data.securityDefinitions = [];
		for (var s in securityContainer) {
			var secdef = securityContainer[s];
			var desc = secdef.description ? secdef.description : '';
			if (secdef.type == 'oauth2') {
				secdef.flowArray = [];
				for (var f in secdef.flows) {
					var flow = secdef.flows[f];
					flow.flowName = f;
					flow.scopeArray = [];
					for (var s in flow.scopes) {
						var scope = {};
						scope.name = s;
						scope.description = flow.scopes[s];
						flow.scopeArray.push(scope);
					}
					secdef.flowArray.push(flow);
				}
			}
			secdef.ref = s;
			if (!secdef.description) secdef.description = '';
			data.securityDefinitions.push(secdef);
		}
		data = options.templateCallback('security', 'pre', data);
		if (data.append) { content += data.append; delete data.append; }
		content += templates.security(data);
		data = options.templateCallback('security', 'post', data);
		if (data.append) { content += data.append; delete data.append; }
	}

	var apiInfo = convertToToc(openapi);

	for (var r in apiInfo.resources) {
		content += '# ' + r + '\n\n';
		var resource = apiInfo.resources[r]
		if (resource.description) content += resource.description + '\n\n';

		if (resource.externalDocs) {
			if (resource.externalDocs.url) {
				content += '<a href="' + resource.externalDocs.url + '">' + (resource.externalDocs.description ? resource.externalDocs.description : 'External docs') + '</a>\n';
			}
		}

		for (var m in resource.methods) {
			var method = resource.methods[m];
			var subtitle = method.op.toUpperCase() + ' ' + method.path;
			var op = openapi.paths[method.path][method.op];
			if ((method.op != 'parameters') && (!method.op.startsWith('x-'))) {

				var opName = (op.operationId ? op.operationId : subtitle);
				content += '## ' + opName + '\n\n';

				var url = data.servers[0].url + method.path;
				var produces = [];
				var consumes = [];

				if (op.requestBody) {
					if (op.requestBody.$ref) {
						op.requestBody = jptr.jptr(openapi,op.requestBody.$ref);
					}
					for (var rb in op.requestBody.content) {
						consumes.push(rb);
					}
				}
				for (var r in op.responses) {
					var response = op.responses[r];
					if (response.$ref) {
						response = jptr.jptr(openapi,response.$ref);
					}
					for (var prod in response.content) {
						produces.push(prod);
					}
				}

				data.method = method.op;
				data.methodUpper = method.op.toUpperCase();
				data.produces = produces;
				data.consumes = consumes;
				data.url = url;
				data.operation = method;
				data.operationId = openapi.paths[method.path][method.op].operationId;
				data.tags = openapi.paths[method.path][method.op].tags;
				data.security = openapi.paths[method.path][method.op].security;
				data.resource = resource;
				data.queryString = '';
				data.requiredQueryString = '';
				data.queryParameters = [];
				data.requiredParameters = [];
				data.headerParameters = [];
				data.bodyParameter = null;

				var sharedParameters = openapi.paths[method.path].parameters || [];
				var opParameters = (openapi.paths[method.path][method.op].parameters || []);
				
				// dereference shared/op parameters while separate before removing overridden shared parameters
				for (var p in sharedParameters) {
					if (sharedParameters[p]["$ref"]) {
						sharedParameters[p] = jptr.jptr(openapi, sharedParameters[p]["$ref"]);
					}
				}
				for (var p in opParameters) {
					if (opParameters[p]["$ref"]) {
						opParameters[p] = jptr.jptr(openapi, opParameters[p]["$ref"]);
					}
				}

				// remove overridden shared (path) parameters
				if ((sharedParameters.length > 0) && (opParameters.length > 0)) {
					sharedParameters = [].concat(sharedParameters); // clone
					for (var sp of sharedParameters) {
						var match = opParameters.find(function (elem) {
							return ((elem.name == sp.name) && (elem.in == sp.in));
						});
						if (match) {
							sp["x-widdershins-delete"] = true;
						}
					}
					sharedParameters = sharedParameters.filter(function (e, i, a) {
						return !e["x-widdershins-delete"];
					});
				}
				
				// combine
				var parameters = sharedParameters.concat(opParameters);

				if (op.requestBody) {
					// fake a version 2-style body parameter for now
					var body = {};
					body.name = 'body';
					body.in = 'body';
					body.type = 'object';
					body.required = true; // possibly
					body.description = 'No description'; // todo
					body.schema = op.requestBody.content[Object.keys(op.requestBody.content)[0]].schema;
					parameters.push(body);
				}

				for (var p in parameters) {
					var param = parameters[p];
					param.required = (param.required ? param.required : false);
					param.safeType = (param.type || 'object');
					if (param.safeType == 'object') {
						if (param.schema && param.schema.type) {
							param.safeType = param.schema.type;
						}
						if (param.schema && param.schema["$ref"]) {
							param.safeType = param.schema["$ref"].split('/').pop();
						}
					}
					if ((param.safeType == 'array') && param.items && param.items.type) {
						param.safeType += '[' + param.items.type + ']';
					}
					if ((param.safeType == 'array') && param.schema && param.schema.items && param.schema.items["$ref"]) {
						param.safeType += '[' + param.schema.items["$ref"].split('/').pop() + ']';
					}
					param.exampleSchema = param.schema || {};
					param.exampleValues = {};
					param.exampleValues.json = {};
					try {
						var obj = sampler.sample(param.exampleSchema, { skipReadOnly: true });
						var t = obj[param.name];
						if (typeof t == 'string') t = "'" + t + "'";
						if (typeof t == 'object') t = JSON.stringify(t, null, 2);
						param.exampleValues.json = t;
						param.exampleValues.object = obj[param.name];
					}
					catch (ex) {
						console.log('# ' + ex);
						param.exampleValues.json = '...';
					}
					if (param.in == 'body') {
						data.bodyParameter = param;
					}
					if (param.in == 'header') {
						data.headerParameters.push(param);
					}
					if (param.in == 'query') {
						var temp = param.exampleValues.object;
						if (Array.isArray(temp)) {
							temp = '...';
						}
						data.queryString += (data.queryString ? '&' : '?') +
							param.name + '=' + encodeURIComponent(temp);
						data.queryParameters.push(param);
						if (param.required) {
							data.requiredQueryString += (data.requiredQueryString ?
								'&' : '?') + param.name + '=' + encodeURIComponent(temp);
							data.requiredParameters.push(param);
						}
					}
				}
				data.parameters = parameters;

				data.allHeaders = common.clone(data.headerParameters);
				if (data.produces.length) {
					var accept = {};
					accept.name = 'Content-Type';
					accept.type = 'string';
					accept.in = 'header';
					accept.exampleValues = {};
					accept.exampleValues.json = "'" + data.produces[0] + "'";
					accept.exampleValues.object = data.produces[0];
					data.allHeaders.push(accept);
				}
				if (data.consumes.length) {
					var contentType = {};
					contentType.name = 'Accept';
					contentType.type = 'string';
					contentType.in = 'header';
					contentType.exampleValues = {};
					contentType.exampleValues.json = "'" + data.consumes[0] + "'";
					contentType.exampleValues.object = data.consumes[0];
					data.allHeaders.push(contentType);
				}

				var codeSamples = (options.codeSamples || op["x-code-samples"]);
				if (codeSamples) {
					data = options.templateCallback('heading_code_samples', 'pre', data);
					if (data.append) { content += data.append; delete data.append; }
					content += templates.heading_code_samples(data);
					data = options.templateCallback('heading_code_samples', 'post', data);
					if (data.append) { content += data.append; delete data.append; }

					if (op["x-code-samples"]) {
						for (var s in op["x-code-samples"]) {
							var sample = op["x-code-samples"][s];
							var lang = common.languageCheck(sample.lang, header.language_tabs, true);
							content += '```' + lang + '\n';
							content += sample.source;
							content += '\n```\n';
						}
					}
					else {
						if (common.languageCheck('shell', header.language_tabs, false)) {
							content += '```shell\n';
							data = options.templateCallback('code_shell', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_shell(data);
							data = options.templateCallback('code_shell', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('http', header.language_tabs, false)) {
							content += '```http\n';
							data = options.templateCallback('code_http', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_http(data);
							data = options.templateCallback('code_http', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('javascript', header.language_tabs, false)) {
							content += '```javascript\n';
							data = options.templateCallback('code_javascript', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_javascript(data);
							data = options.templateCallback('code_javascript', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('javascript--nodejs', header.language_tabs, false)) {
							content += '```javascript--nodejs\n';
							data = options.templateCallback('code_nodejs', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_nodejs(data);
							data = options.templateCallback('code_nodejs', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('ruby', header.language_tabs, false)) {
							content += '```ruby\n';
							data = options.templateCallback('code_ruby', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_ruby(data);
							data = options.templateCallback('code_ruby', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('python', header.language_tabs, false)) {
							content += '```python\n';
							data = options.templateCallback('code_python', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_python(data);
							data = options.templateCallback('code_python', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
						if (common.languageCheck('java', header.language_tabs, false)) {
							content += '```java\n';
							data = options.templateCallback('code_java', 'pre', data);
							if (data.append) { content += data.append; delete data.append; }
							content += templates.code_java(data);
							data = options.templateCallback('code_java', 'post', data);
							if (data.append) { content += data.append; delete data.append; }
							content += '```\n\n';
						}
					}
				}

				if (subtitle != opName) content += '`' + subtitle + '`\n\n';
				if (op.summary) content += '*' + op.summary + '*\n\n';
				if (op.description) content += op.description + '\n\n';

				data.enums = [];

				if (parameters.length > 0) {
					var longDescs = false;
					for (var p in parameters) {
						param = parameters[p];
						param.shortDesc = param.description ? param.description.split('\n')[0] : 'No description';
						if (param.description && (param.description.trim().split('\n').length > 1)) longDescs = true;
						param.originalType = param.type;
						param.type = param.safeType;

						if (param.enum) {
							for (var e in param.enum) {
								var nvp = {};
								nvp.name = param.name;
								nvp.value = param.enum[e];
								data.enums.push(nvp);
							}
						}
						if (param.items && param.items.enum) {
							for (var e in param.items.enum) {
								var nvp = {};
								nvp.name = param.name;
								nvp.value = param.items.enum[e];
								data.enums.push(nvp);
							}
						}

					}
					data.parameters = parameters; // redundant?
					data = options.templateCallback('parameters', 'pre', data);
					if (data.append) { content += data.append; delete data.append; }
					content += templates.parameters(data);
					data = options.templateCallback('parameters', 'post', data);
					if (data.append) { content += data.append; delete data.append; }

					if (longDescs) {
						for (var p in parameters) {
							var param = parameters[p];
							//if (param["$ref"]) {
							//    param = jptr.jptr(openapi,param["$ref"]);
							//}
							var desc = param.description ? param.description : '';
							var descs = desc.trim().split('\n');
							if (descs.length > 1) {
								content += '##### ' + param.name + '\n';
								content += desc + '\n';
							}
						}
					}

					var paramHeader = false;
					for (var p in parameters) {
						param = parameters[p];
						//if (param["$ref"]) {
						//    param = jptr.jptr(openapi,param["$ref"]);
						//}
						if (param.schema) {
							if (!paramHeader) {
								data = options.templateCallback('heading_body_parameter', 'pre', data);
								if (data.append) { content += data.append; delete data.append; }
								content += templates.heading_body_parameter(data);
								data = options.templateCallback('heading_body_parameter', 'post', data);
								if (data.append) { content += data.append; delete data.append; }
								paramHeader = true;
							}
							var xmlWrap = '';
							var obj = common.dereference(param.schema, circles, openapi);
							if (obj.xml && obj.xml.name) {
								xmlWrap = obj.xml.name;
							}
							if (options.sample) {
								try {
									obj = sampler.sample(obj, { skipReadOnly: true });
								}
								catch (ex) {
									console.log('# ' + ex);
								}
							}
							if (obj.properties) obj = obj.properties;
							if (common.doContentType(consumes, common.jsonContentTypes)) {
								content += '```json\n';
								content += JSON.stringify(obj, null, 2) + '\n';
								content += '```\n';
							}
							if (common.doContentType(consumes, common.yamlContentTypes)) {
								content += '```yaml\n';
								content += yaml.safeDump(obj) + '\n';
								content += '```\n';
							}
							if (common.doContentType(consumes, common.xmlContentTypes)) {
								content += '```xml\n';
								if (xmlWrap) {
									var newObj = {};
									newObj[xmlWrap] = obj;
									obj = newObj;
								}
								content += xml.getXml(obj, '@', '', true, '  ', false) + '\n';
								content += '```\n';
							}
						}
					}

				}

				var responseSchemas = false;
				var responseHeaders = false;
				data.responses = [];
				for (var resp in op.responses) {
					var response = op.responses[resp];
					if (response.schema) responseSchemas = true;
					if (response.headers) responseHeaders = true;

					response.status = resp;
					response.meaning = (resp == 'default' ? 'Default' : 'Unknown');
					var url = '';
					for (var s in common.statusCodes) {
						if (common.statusCodes[s].code == resp) {
							response.meaning = common.statusCodes[s].phrase;
							url = common.statusCodes[s].spec_href;
							break;
						}
					}
					if (url) response.meaning = '[' + response.meaning + '](' + url + ')';
					if (!response.description) response.description = 'No description';
					response.description = response.description.trim();
					data.responses.push(response);
				}
				data = options.templateCallback('responses', 'pre', data);
				if (data.append) { content += data.append; delete data.append; }
				content += templates.responses(data);
				data = options.templateCallback('responses', 'post', data);
				if (data.append) { content += data.append; delete data.append; }

				if (responseHeaders) {
					data.response_headers = [];
					for (var resp in op.responses) {
						var response = op.responses[resp];
						for (var h in response.headers) {
							var hdr = response.headers[h];
							hdr.status = resp;
							hdr.header = h;
							if (!hdr.format) hdr.format = '';
							if (!hdr.description) hdr.description = '';
							if (!hdr.type && hdr.schema && hdr.schema.type) {
								hdr.type = hdr.schema.type;
								hdr.format = hdr.schema.format||'';
							}

							data.response_headers.push(hdr);
						}
					}
					data = options.templateCallback('response_headers', 'pre', data);
					content += templates.response_headers(data);
					if (data.append) { content += data.append; delete data.append; }
					data = options.templateCallback('response_headers', 'post', data);
					if (data.append) { content += data.append; delete data.append; }
				}

				if (responseSchemas) {
					data = options.templateCallback('heading_example_responses', 'pre', data);
					if (data.append) { content += data.append; delete data.append; }
					content += templates.heading_example_responses(data);
					data = options.templateCallback('heading_example_responses', 'post', data);
					if (data.append) { content += data.append; delete data.append; }
					for (var resp in op.responses) {
						var response = op.responses[resp];
						if (response.schema) {
							var xmlWrap = '';
							var obj = common.dereference(response.schema, circles, openapi);
							if (obj.xml && obj.xml.name) {
								xmlWrap = obj.xml.name;
							}
							if (Object.keys(obj).length > 0) {
								if (options.sample) {
									try {
										obj = sampler.sample(obj); // skipReadOnly: false
									}
									catch (ex) {
										console.log('# ' + ex);
									}
								}
								if (common.doContentType(produces, common.jsonContentTypes)) {
									content += '```json\n';
									content += JSON.stringify(obj, null, 2) + '\n';
									content += '```\n';
								}
								if (common.doContentType(produces, common.yamlContentTypes)) {
									content += '```json\n';
									content += yaml.safeDump(obj) + '\n';
									content += '```\n';
								}
								if (xmlWrap) {
									var newObj = {};
									newObj[xmlWrap] = obj;
									obj = newObj;
								}
								if ((typeof obj === 'object') && common.doContentType(produces, common.xmlContentTypes)) {
									content += '```xml\n';
									content += xml.getXml(obj, '@', '', true, '  ', false) + '\n';
									content += '```\n';
								}
							}
						}
					}
				}

				var security = (op.security ? op.security : openapi.security);
				if (!security) security = [];
				if (security.length <= 0) {
					data = options.templateCallback('authentication_none', 'pre', data);
					if (data.append) { content += data.append; delete data.append; }
					content += templates.authentication_none(data);
					data = options.templateCallback('authentication_none', 'post', data);
					if (data.append) { content += data.append; delete data.append; }
				}
				else {
					data.securityDefinitions = [];
					var list = '';
					for (var s in security) {
						var link;
						link = '#/components/securitySchemes/' + Object.keys(security[s])[0];
						var secDef = jptr.jptr(openapi, link);
						data.securityDefinitions.push(secDef);
						list += (list ? ', ' : '') + secDef.type;
						var scopes = security[s][Object.keys(security[s])[0]];
						if (Array.isArray(scopes) && (scopes.length > 0)) {
							list += ' ( Scopes: ';
							for (var scope in scopes) {
								list += scopes[scope] + ' ';
							}
							list += ')';
						}
					}
					data.authenticationStr = list;
					data = options.templateCallback('authentication', 'pre', data);
					if (data.append) { content += data.append; delete data.append; }
					content += templates.authentication(data);
					data = options.templateCallback('authentication', 'post', data);
					if (data.append) { content += data.append; delete data.append; }
				}

				content += '\n';

			}
		}
	}

	data = options.templateCallback('footer', 'pre', data);
	if (data.append) { content += data.append; delete data.append; }
	content += templates.footer(data) + '\n';
	data = options.templateCallback('footer', 'post', data);
	if (data.append) { content += data.append; delete data.append; }

	if (options.discovery) {
		data = options.templateCallback('discovery', 'pre', data);
		if (data.append) { content += data.append; delete data.append; }
		content += templates.discovery(data) + '\n';
		data = options.templateCallback('discovery', 'post', data);
		if (data.append) { content += data.append; delete data.append; }
	}

	var headerStr = '---\n' + yaml.safeDump(header) + '---\n';
	// apparently you can insert jekyll front-matter in here for github -- see lord/slate
	var result = (headerStr + '\n' + content.split('\n\n\n').join('\n\n'));
	if (callback) callback(null, result);
	return result;
}

module.exports = {
	convert: convert
};
