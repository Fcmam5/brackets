/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, forin: true, maxerr: 50, regexp: true */
/*global define, $, XMLHttpRequest, window */

/**
 * RemoteAgent defines and provides an interface for custom remote functions
 * loaded from RemoteFunctions. Remote commands are executed via
 * `call(name, varargs)`.
 *
 * Remote events are dispatched as events on this object.
 */
define(function RemoteAgent(require, exports, module) {
    "use strict";

    var $exports = $(exports);

    var LiveDevelopment = require("LiveDevelopment/LiveDevelopment"),
        Inspector       = require("LiveDevelopment/Inspector/Inspector"),
        RemoteFunctions = require("text!LiveDevelopment/Agents/RemoteFunctions.js"),
        jQueryRemoteSrc = require("text!thirdparty/jQuery-2.0.1.min.js");

    var $REMOTE = "window._LDjQuery";

    var _load; // deferred load
    var _objectId; // the object id of the remote object
    var _jQueryRemoteObjectId;
    var _intervalId; // interval used to send keepAlive events

    // WebInspector Event: DOM.attributeModified
    function _onAttributeModified(event, res) {
        // res = {nodeId, name, value}
        var matches = /^data-ld-(.*)/.exec(res.name);
        if (matches) {
            $exports.triggerHandler(matches[1], res);
        }
    }

    function _call(objectId, method, varargs) {
        console.assert(objectId, "Attempted to call remote method without objectId set.");
        var args = Array.prototype.slice.call(arguments, 2),
            callback,
            deferred = new $.Deferred();

        // if the last argument is a function it is the callback function
        if (typeof args[args.length - 1] === "function") {
            callback = args.pop();
        }

        // Resolve node parameters
        args = args.map(function (arg) {
            if (arg && arg.nodeId) {
                return arg.resolve();
            }

            return arg;
        });

        $.when.apply(undefined, args).done(function onResolvedAllNodes() {
            var params = [];

            args.forEach(function (arg) {
                if (arg.objectId) {
                    params.push({objectId: arg.objectId});
                } else {
                    params.push({value: arg});
                }
            });

            Inspector.Runtime.callFunctionOn(objectId, method, params, undefined, callback)
                .then(deferred.resolve, deferred.reject);
        });

        return deferred.promise();
    }

    /** Call a remote function
     * The parameters are passed on to the remote functions. Nodes are resolved
     * and sent as objectIds.
     * @param {string} function name
     */
    function call(method, varargs) {
        var argsArray = [_objectId, "_LD." + method];

        if (arguments.length > 1) {
            argsArray = argsArray.concat(Array.prototype.slice.call(arguments, 1));
        }

        return _call.apply(null, argsArray);
    }

    function jQueryRemote(method, varargs) {
        return _call(_jQueryRemoteObjectId, "_LDjQuery." + method, varargs);
    }

    function _stopKeepAliveInterval() {
        if (_intervalId) {
            window.clearInterval(_intervalId);
            _intervalId = null;
        }
    }

    function _startKeepAliveInterval() {
        _stopKeepAliveInterval();

        _intervalId = window.setInterval(function () {
            call("keepAlive");
        }, 1000);
    }

    /**
     * @private
     * Cancel the keepAlive interval if the page reloads
     */
    function _onFrameStartedLoading(event, res) {
        _stopKeepAliveInterval();
    }

    // WebInspector Event: Page.loadEventFired
    function _onLoadEventFired(event, res) {
        // res = {timestamp}

        // inject RemoteFunctions
        var command = "window._LD=" + RemoteFunctions + "(" + LiveDevelopment.config.experimental + ");";

        Inspector.Runtime.evaluate(command, function onEvaluate(response) {
            if (response.error || response.wasThrown) {
                _load.reject(null, response.error);
            } else {
                _objectId = response.result.objectId;
                _load.resolve();

                _startKeepAliveInterval();
            }
        });

        // inject jQuery
        command = jQueryRemoteSrc + "window._LDjQuery=jQuery.noConflict(true);";

        Inspector.Runtime.evaluate(command, function onEvaluate(response) {
            if (response.error || response.wasThrown) {
                _load.reject(null, response.error);
            } else {
                _jQueryRemoteObjectId = response.result.objectId;
            }
        });
    }

    /** Initialize the agent */
    function load() {
        _load = new $.Deferred();
        $(Inspector.Page).on("loadEventFired.RemoteAgent", _onLoadEventFired);
        $(Inspector.Page).on("frameStartedLoading.RemoteAgent", _onFrameStartedLoading);
        $(Inspector.DOM).on("attributeModified.RemoteAgent", _onAttributeModified);

        return _load.promise();
    }

    /** Clean up */
    function unload() {
        $(Inspector.Page).off(".RemoteAgent");
        $(Inspector.DOM).off(".RemoteAgent");
        _stopKeepAliveInterval();
    }

    // Prototype DOM manipulation
    var REMOTE_ELEMENT_METHODS = [
        "attr", "removeAttr",
        "before", "after", "append", "prepend",
        "text",
        "detach", "remove",
        "html"
    ];

    function RemoteElement(dataBracketsId) {
        var self = this;

        this._dataBracketsId = dataBracketsId;
        this._evalFind = $REMOTE + '("[data-brackets-id=\\"' + this._dataBracketsId + '\\"]").';

        REMOTE_ELEMENT_METHODS.forEach(function (methodName) {
            self[methodName] = self._eval.bind(self, methodName);
        });
    }

    RemoteElement.prototype._eval = function (method, varargs) {
        var argsArray = Array.prototype.slice.call(arguments, 1);

        argsArray = argsArray.map(function (arg) {
            // TODO all basic types: boolean, array, etc.
            if (typeof arg === "string") {
                // add quotes to stirngs
                return '"' + arg + '"';
            }

            return arg;
        });

        return Inspector.Runtime.evaluate(this._evalFind + method + "(" + argsArray.join(",") + ")");
    };

    function remoteElement(dataBracketsId) {
        return new RemoteElement(dataBracketsId);
    }

    // Export public functions
    exports.call = call;
    exports.jQuery = jQueryRemote;
    exports.load = load;
    exports.unload = unload;
    exports.remoteElement = remoteElement;
});
