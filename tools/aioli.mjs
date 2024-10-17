const proxyMarker = Symbol("Comlink.proxy");
const createEndpoint = Symbol("Comlink.endpoint");
const releaseProxy = Symbol("Comlink.releaseProxy");
const throwMarker = Symbol("Comlink.thrown");
const isObject = (val) => typeof val === "object" && val !== null || typeof val === "function";
const proxyTransferHandler = {
  canHandle: (val) => isObject(val) && val[proxyMarker],
  serialize(obj) {
    const { port1, port2 } = new MessageChannel();
    expose(obj, port1);
    return [port2, [port2]];
  },
  deserialize(port) {
    port.start();
    return wrap(port);
  }
};
const throwTransferHandler = {
  canHandle: (value) => isObject(value) && throwMarker in value,
  serialize({ value }) {
    let serialized;
    if (value instanceof Error) {
      serialized = {
        isError: true,
        value: {
          message: value.message,
          name: value.name,
          stack: value.stack
        }
      };
    } else {
      serialized = { isError: false, value };
    }
    return [serialized, []];
  },
  deserialize(serialized) {
    if (serialized.isError) {
      throw Object.assign(new Error(serialized.value.message), serialized.value);
    }
    throw serialized.value;
  }
};
const transferHandlers = /* @__PURE__ */ new Map([
  ["proxy", proxyTransferHandler],
  ["throw", throwTransferHandler]
]);
function expose(obj, ep = self) {
  ep.addEventListener("message", function callback(ev) {
    if (!ev || !ev.data) {
      return;
    }
    const { id, type, path } = Object.assign({ path: [] }, ev.data);
    const argumentList = (ev.data.argumentList || []).map(fromWireValue);
    let returnValue;
    try {
      const parent = path.slice(0, -1).reduce((obj2, prop) => obj2[prop], obj);
      const rawValue = path.reduce((obj2, prop) => obj2[prop], obj);
      switch (type) {
        case "GET":
          {
            returnValue = rawValue;
          }
          break;
        case "SET":
          {
            parent[path.slice(-1)[0]] = fromWireValue(ev.data.value);
            returnValue = true;
          }
          break;
        case "APPLY":
          {
            returnValue = rawValue.apply(parent, argumentList);
          }
          break;
        case "CONSTRUCT":
          {
            const value = new rawValue(...argumentList);
            returnValue = proxy(value);
          }
          break;
        case "ENDPOINT":
          {
            const { port1, port2 } = new MessageChannel();
            expose(obj, port2);
            returnValue = transfer(port1, [port1]);
          }
          break;
        case "RELEASE":
          {
            returnValue = void 0;
          }
          break;
        default:
          return;
      }
    } catch (value) {
      returnValue = { value, [throwMarker]: 0 };
    }
    Promise.resolve(returnValue).catch((value) => {
      return { value, [throwMarker]: 0 };
    }).then((returnValue2) => {
      const [wireValue, transferables] = toWireValue(returnValue2);
      ep.postMessage(Object.assign(Object.assign({}, wireValue), { id }), transferables);
      if (type === "RELEASE") {
        ep.removeEventListener("message", callback);
        closeEndPoint(ep);
      }
    });
  });
  if (ep.start) {
    ep.start();
  }
}
function isMessagePort(endpoint) {
  return endpoint.constructor.name === "MessagePort";
}
function closeEndPoint(endpoint) {
  if (isMessagePort(endpoint))
    endpoint.close();
}
function wrap(ep, target) {
  return createProxy(ep, [], target);
}
function throwIfProxyReleased(isReleased) {
  if (isReleased) {
    throw new Error("Proxy has been released and is not useable");
  }
}
function createProxy(ep, path = [], target = function() {
}) {
  let isProxyReleased = false;
  const proxy2 = new Proxy(target, {
    get(_target, prop) {
      throwIfProxyReleased(isProxyReleased);
      if (prop === releaseProxy) {
        return () => {
          return requestResponseMessage(ep, {
            type: "RELEASE",
            path: path.map((p) => p.toString())
          }).then(() => {
            closeEndPoint(ep);
            isProxyReleased = true;
          });
        };
      }
      if (prop === "then") {
        if (path.length === 0) {
          return { then: () => proxy2 };
        }
        const r = requestResponseMessage(ep, {
          type: "GET",
          path: path.map((p) => p.toString())
        }).then(fromWireValue);
        return r.then.bind(r);
      }
      return createProxy(ep, [...path, prop]);
    },
    set(_target, prop, rawValue) {
      throwIfProxyReleased(isProxyReleased);
      const [value, transferables] = toWireValue(rawValue);
      return requestResponseMessage(ep, {
        type: "SET",
        path: [...path, prop].map((p) => p.toString()),
        value
      }, transferables).then(fromWireValue);
    },
    apply(_target, _thisArg, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const last = path[path.length - 1];
      if (last === createEndpoint) {
        return requestResponseMessage(ep, {
          type: "ENDPOINT"
        }).then(fromWireValue);
      }
      if (last === "bind") {
        return createProxy(ep, path.slice(0, -1));
      }
      const [argumentList, transferables] = processArguments(rawArgumentList);
      return requestResponseMessage(ep, {
        type: "APPLY",
        path: path.map((p) => p.toString()),
        argumentList
      }, transferables).then(fromWireValue);
    },
    construct(_target, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const [argumentList, transferables] = processArguments(rawArgumentList);
      return requestResponseMessage(ep, {
        type: "CONSTRUCT",
        path: path.map((p) => p.toString()),
        argumentList
      }, transferables).then(fromWireValue);
    }
  });
  return proxy2;
}
function myFlat(arr) {
  return Array.prototype.concat.apply([], arr);
}
function processArguments(argumentList) {
  const processed = argumentList.map(toWireValue);
  return [processed.map((v) => v[0]), myFlat(processed.map((v) => v[1]))];
}
const transferCache = /* @__PURE__ */ new WeakMap();
function transfer(obj, transfers) {
  transferCache.set(obj, transfers);
  return obj;
}
function proxy(obj) {
  return Object.assign(obj, { [proxyMarker]: true });
}
function toWireValue(value) {
  for (const [name, handler] of transferHandlers) {
    if (handler.canHandle(value)) {
      const [serializedValue, transferables] = handler.serialize(value);
      return [
        {
          type: "HANDLER",
          name,
          value: serializedValue
        },
        transferables
      ];
    }
  }
  return [
    {
      type: "RAW",
      value
    },
    transferCache.get(value) || []
  ];
}
function fromWireValue(value) {
  switch (value.type) {
    case "HANDLER":
      return transferHandlers.get(value.name).deserialize(value.value);
    case "RAW":
      return value.value;
  }
}
function requestResponseMessage(ep, msg, transfers) {
  return new Promise((resolve) => {
    const id = generateUUID();
    ep.addEventListener("message", function l(ev) {
      if (!ev.data || !ev.data.id || ev.data.id !== id) {
        return;
      }
      ep.removeEventListener("message", l);
      resolve(ev.data);
    });
    if (ep.start) {
      ep.start();
    }
    ep.postMessage(Object.assign({ id }, msg), transfers);
  });
}
function generateUUID() {
  return new Array(4).fill(0).map(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16)).join("-");
}
const encodedJs = "KGZ1bmN0aW9uKCkgewogICJ1c2Ugc3RyaWN0IjsKICBjb25zdCBwcm94eU1hcmtlciA9IFN5bWJvbCgiQ29tbGluay5wcm94eSIpOwogIGNvbnN0IGNyZWF0ZUVuZHBvaW50ID0gU3ltYm9sKCJDb21saW5rLmVuZHBvaW50Iik7CiAgY29uc3QgcmVsZWFzZVByb3h5ID0gU3ltYm9sKCJDb21saW5rLnJlbGVhc2VQcm94eSIpOwogIGNvbnN0IHRocm93TWFya2VyID0gU3ltYm9sKCJDb21saW5rLnRocm93biIpOwogIGNvbnN0IGlzT2JqZWN0ID0gKHZhbCkgPT4gdHlwZW9mIHZhbCA9PT0gIm9iamVjdCIgJiYgdmFsICE9PSBudWxsIHx8IHR5cGVvZiB2YWwgPT09ICJmdW5jdGlvbiI7CiAgY29uc3QgcHJveHlUcmFuc2ZlckhhbmRsZXIgPSB7CiAgICBjYW5IYW5kbGU6ICh2YWwpID0+IGlzT2JqZWN0KHZhbCkgJiYgdmFsW3Byb3h5TWFya2VyXSwKICAgIHNlcmlhbGl6ZShvYmopIHsKICAgICAgY29uc3QgeyBwb3J0MSwgcG9ydDIgfSA9IG5ldyBNZXNzYWdlQ2hhbm5lbCgpOwogICAgICBleHBvc2Uob2JqLCBwb3J0MSk7CiAgICAgIHJldHVybiBbcG9ydDIsIFtwb3J0Ml1dOwogICAgfSwKICAgIGRlc2VyaWFsaXplKHBvcnQpIHsKICAgICAgcG9ydC5zdGFydCgpOwogICAgICByZXR1cm4gd3JhcChwb3J0KTsKICAgIH0KICB9OwogIGNvbnN0IHRocm93VHJhbnNmZXJIYW5kbGVyID0gewogICAgY2FuSGFuZGxlOiAodmFsdWUpID0+IGlzT2JqZWN0KHZhbHVlKSAmJiB0aHJvd01hcmtlciBpbiB2YWx1ZSwKICAgIHNlcmlhbGl6ZSh7IHZhbHVlIH0pIHsKICAgICAgbGV0IHNlcmlhbGl6ZWQ7CiAgICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIEVycm9yKSB7CiAgICAgICAgc2VyaWFsaXplZCA9IHsKICAgICAgICAgIGlzRXJyb3I6IHRydWUsCiAgICAgICAgICB2YWx1ZTogewogICAgICAgICAgICBtZXNzYWdlOiB2YWx1ZS5tZXNzYWdlLAogICAgICAgICAgICBuYW1lOiB2YWx1ZS5uYW1lLAogICAgICAgICAgICBzdGFjazogdmFsdWUuc3RhY2sKICAgICAgICAgIH0KICAgICAgICB9OwogICAgICB9IGVsc2UgewogICAgICAgIHNlcmlhbGl6ZWQgPSB7IGlzRXJyb3I6IGZhbHNlLCB2YWx1ZSB9OwogICAgICB9CiAgICAgIHJldHVybiBbc2VyaWFsaXplZCwgW11dOwogICAgfSwKICAgIGRlc2VyaWFsaXplKHNlcmlhbGl6ZWQpIHsKICAgICAgaWYgKHNlcmlhbGl6ZWQuaXNFcnJvcikgewogICAgICAgIHRocm93IE9iamVjdC5hc3NpZ24obmV3IEVycm9yKHNlcmlhbGl6ZWQudmFsdWUubWVzc2FnZSksIHNlcmlhbGl6ZWQudmFsdWUpOwogICAgICB9CiAgICAgIHRocm93IHNlcmlhbGl6ZWQudmFsdWU7CiAgICB9CiAgfTsKICBjb25zdCB0cmFuc2ZlckhhbmRsZXJzID0gLyogQF9fUFVSRV9fICovIG5ldyBNYXAoWwogICAgWyJwcm94eSIsIHByb3h5VHJhbnNmZXJIYW5kbGVyXSwKICAgIFsidGhyb3ciLCB0aHJvd1RyYW5zZmVySGFuZGxlcl0KICBdKTsKICBmdW5jdGlvbiBleHBvc2Uob2JqLCBlcCA9IHNlbGYpIHsKICAgIGVwLmFkZEV2ZW50TGlzdGVuZXIoIm1lc3NhZ2UiLCBmdW5jdGlvbiBjYWxsYmFjayhldikgewogICAgICBpZiAoIWV2IHx8ICFldi5kYXRhKSB7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGNvbnN0IHsgaWQsIHR5cGUsIHBhdGggfSA9IE9iamVjdC5hc3NpZ24oeyBwYXRoOiBbXSB9LCBldi5kYXRhKTsKICAgICAgY29uc3QgYXJndW1lbnRMaXN0ID0gKGV2LmRhdGEuYXJndW1lbnRMaXN0IHx8IFtdKS5tYXAoZnJvbVdpcmVWYWx1ZSk7CiAgICAgIGxldCByZXR1cm5WYWx1ZTsKICAgICAgdHJ5IHsKICAgICAgICBjb25zdCBwYXJlbnQgPSBwYXRoLnNsaWNlKDAsIC0xKS5yZWR1Y2UoKG9iajIsIHByb3ApID0+IG9iajJbcHJvcF0sIG9iaik7CiAgICAgICAgY29uc3QgcmF3VmFsdWUgPSBwYXRoLnJlZHVjZSgob2JqMiwgcHJvcCkgPT4gb2JqMltwcm9wXSwgb2JqKTsKICAgICAgICBzd2l0Y2ggKHR5cGUpIHsKICAgICAgICAgIGNhc2UgIkdFVCI6CiAgICAgICAgICAgIHsKICAgICAgICAgICAgICByZXR1cm5WYWx1ZSA9IHJhd1ZhbHVlOwogICAgICAgICAgICB9CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgY2FzZSAiU0VUIjoKICAgICAgICAgICAgewogICAgICAgICAgICAgIHBhcmVudFtwYXRoLnNsaWNlKC0xKVswXV0gPSBmcm9tV2lyZVZhbHVlKGV2LmRhdGEudmFsdWUpOwogICAgICAgICAgICAgIHJldHVyblZhbHVlID0gdHJ1ZTsKICAgICAgICAgICAgfQogICAgICAgICAgICBicmVhazsKICAgICAgICAgIGNhc2UgIkFQUExZIjoKICAgICAgICAgICAgewogICAgICAgICAgICAgIHJldHVyblZhbHVlID0gcmF3VmFsdWUuYXBwbHkocGFyZW50LCBhcmd1bWVudExpc3QpOwogICAgICAgICAgICB9CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgY2FzZSAiQ09OU1RSVUNUIjoKICAgICAgICAgICAgewogICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gbmV3IHJhd1ZhbHVlKC4uLmFyZ3VtZW50TGlzdCk7CiAgICAgICAgICAgICAgcmV0dXJuVmFsdWUgPSBwcm94eSh2YWx1ZSk7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICBjYXNlICJFTkRQT0lOVCI6CiAgICAgICAgICAgIHsKICAgICAgICAgICAgICBjb25zdCB7IHBvcnQxLCBwb3J0MiB9ID0gbmV3IE1lc3NhZ2VDaGFubmVsKCk7CiAgICAgICAgICAgICAgZXhwb3NlKG9iaiwgcG9ydDIpOwogICAgICAgICAgICAgIHJldHVyblZhbHVlID0gdHJhbnNmZXIocG9ydDEsIFtwb3J0MV0pOwogICAgICAgICAgICB9CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgY2FzZSAiUkVMRUFTRSI6CiAgICAgICAgICAgIHsKICAgICAgICAgICAgICByZXR1cm5WYWx1ZSA9IHZvaWQgMDsKICAgICAgICAgICAgfQogICAgICAgICAgICBicmVhazsKICAgICAgICAgIGRlZmF1bHQ6CiAgICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgIH0gY2F0Y2ggKHZhbHVlKSB7CiAgICAgICAgcmV0dXJuVmFsdWUgPSB7IHZhbHVlLCBbdGhyb3dNYXJrZXJdOiAwIH07CiAgICAgIH0KICAgICAgUHJvbWlzZS5yZXNvbHZlKHJldHVyblZhbHVlKS5jYXRjaCgodmFsdWUpID0+IHsKICAgICAgICByZXR1cm4geyB2YWx1ZSwgW3Rocm93TWFya2VyXTogMCB9OwogICAgICB9KS50aGVuKChyZXR1cm5WYWx1ZTIpID0+IHsKICAgICAgICBjb25zdCBbd2lyZVZhbHVlLCB0cmFuc2ZlcmFibGVzXSA9IHRvV2lyZVZhbHVlKHJldHVyblZhbHVlMik7CiAgICAgICAgZXAucG9zdE1lc3NhZ2UoT2JqZWN0LmFzc2lnbihPYmplY3QuYXNzaWduKHt9LCB3aXJlVmFsdWUpLCB7IGlkIH0pLCB0cmFuc2ZlcmFibGVzKTsKICAgICAgICBpZiAodHlwZSA9PT0gIlJFTEVBU0UiKSB7CiAgICAgICAgICBlcC5yZW1vdmVFdmVudExpc3RlbmVyKCJtZXNzYWdlIiwgY2FsbGJhY2spOwogICAgICAgICAgY2xvc2VFbmRQb2ludChlcCk7CiAgICAgICAgfQogICAgICB9KTsKICAgIH0pOwogICAgaWYgKGVwLnN0YXJ0KSB7CiAgICAgIGVwLnN0YXJ0KCk7CiAgICB9CiAgfQogIGZ1bmN0aW9uIGlzTWVzc2FnZVBvcnQoZW5kcG9pbnQpIHsKICAgIHJldHVybiBlbmRwb2ludC5jb25zdHJ1Y3Rvci5uYW1lID09PSAiTWVzc2FnZVBvcnQiOwogIH0KICBmdW5jdGlvbiBjbG9zZUVuZFBvaW50KGVuZHBvaW50KSB7CiAgICBpZiAoaXNNZXNzYWdlUG9ydChlbmRwb2ludCkpCiAgICAgIGVuZHBvaW50LmNsb3NlKCk7CiAgfQogIGZ1bmN0aW9uIHdyYXAoZXAsIHRhcmdldCkgewogICAgcmV0dXJuIGNyZWF0ZVByb3h5KGVwLCBbXSwgdGFyZ2V0KTsKICB9CiAgZnVuY3Rpb24gdGhyb3dJZlByb3h5UmVsZWFzZWQoaXNSZWxlYXNlZCkgewogICAgaWYgKGlzUmVsZWFzZWQpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJQcm94eSBoYXMgYmVlbiByZWxlYXNlZCBhbmQgaXMgbm90IHVzZWFibGUiKTsKICAgIH0KICB9CiAgZnVuY3Rpb24gY3JlYXRlUHJveHkoZXAsIHBhdGggPSBbXSwgdGFyZ2V0ID0gZnVuY3Rpb24oKSB7CiAgfSkgewogICAgbGV0IGlzUHJveHlSZWxlYXNlZCA9IGZhbHNlOwogICAgY29uc3QgcHJveHkyID0gbmV3IFByb3h5KHRhcmdldCwgewogICAgICBnZXQoX3RhcmdldCwgcHJvcCkgewogICAgICAgIHRocm93SWZQcm94eVJlbGVhc2VkKGlzUHJveHlSZWxlYXNlZCk7CiAgICAgICAgaWYgKHByb3AgPT09IHJlbGVhc2VQcm94eSkgewogICAgICAgICAgcmV0dXJuICgpID0+IHsKICAgICAgICAgICAgcmV0dXJuIHJlcXVlc3RSZXNwb25zZU1lc3NhZ2UoZXAsIHsKICAgICAgICAgICAgICB0eXBlOiAiUkVMRUFTRSIsCiAgICAgICAgICAgICAgcGF0aDogcGF0aC5tYXAoKHApID0+IHAudG9TdHJpbmcoKSkKICAgICAgICAgICAgfSkudGhlbigoKSA9PiB7CiAgICAgICAgICAgICAgY2xvc2VFbmRQb2ludChlcCk7CiAgICAgICAgICAgICAgaXNQcm94eVJlbGVhc2VkID0gdHJ1ZTsKICAgICAgICAgICAgfSk7CiAgICAgICAgICB9OwogICAgICAgIH0KICAgICAgICBpZiAocHJvcCA9PT0gInRoZW4iKSB7CiAgICAgICAgICBpZiAocGF0aC5sZW5ndGggPT09IDApIHsKICAgICAgICAgICAgcmV0dXJuIHsgdGhlbjogKCkgPT4gcHJveHkyIH07CiAgICAgICAgICB9CiAgICAgICAgICBjb25zdCByID0gcmVxdWVzdFJlc3BvbnNlTWVzc2FnZShlcCwgewogICAgICAgICAgICB0eXBlOiAiR0VUIiwKICAgICAgICAgICAgcGF0aDogcGF0aC5tYXAoKHApID0+IHAudG9TdHJpbmcoKSkKICAgICAgICAgIH0pLnRoZW4oZnJvbVdpcmVWYWx1ZSk7CiAgICAgICAgICByZXR1cm4gci50aGVuLmJpbmQocik7CiAgICAgICAgfQogICAgICAgIHJldHVybiBjcmVhdGVQcm94eShlcCwgWy4uLnBhdGgsIHByb3BdKTsKICAgICAgfSwKICAgICAgc2V0KF90YXJnZXQsIHByb3AsIHJhd1ZhbHVlKSB7CiAgICAgICAgdGhyb3dJZlByb3h5UmVsZWFzZWQoaXNQcm94eVJlbGVhc2VkKTsKICAgICAgICBjb25zdCBbdmFsdWUsIHRyYW5zZmVyYWJsZXNdID0gdG9XaXJlVmFsdWUocmF3VmFsdWUpOwogICAgICAgIHJldHVybiByZXF1ZXN0UmVzcG9uc2VNZXNzYWdlKGVwLCB7CiAgICAgICAgICB0eXBlOiAiU0VUIiwKICAgICAgICAgIHBhdGg6IFsuLi5wYXRoLCBwcm9wXS5tYXAoKHApID0+IHAudG9TdHJpbmcoKSksCiAgICAgICAgICB2YWx1ZQogICAgICAgIH0sIHRyYW5zZmVyYWJsZXMpLnRoZW4oZnJvbVdpcmVWYWx1ZSk7CiAgICAgIH0sCiAgICAgIGFwcGx5KF90YXJnZXQsIF90aGlzQXJnLCByYXdBcmd1bWVudExpc3QpIHsKICAgICAgICB0aHJvd0lmUHJveHlSZWxlYXNlZChpc1Byb3h5UmVsZWFzZWQpOwogICAgICAgIGNvbnN0IGxhc3QgPSBwYXRoW3BhdGgubGVuZ3RoIC0gMV07CiAgICAgICAgaWYgKGxhc3QgPT09IGNyZWF0ZUVuZHBvaW50KSB7CiAgICAgICAgICByZXR1cm4gcmVxdWVzdFJlc3BvbnNlTWVzc2FnZShlcCwgewogICAgICAgICAgICB0eXBlOiAiRU5EUE9JTlQiCiAgICAgICAgICB9KS50aGVuKGZyb21XaXJlVmFsdWUpOwogICAgICAgIH0KICAgICAgICBpZiAobGFzdCA9PT0gImJpbmQiKSB7CiAgICAgICAgICByZXR1cm4gY3JlYXRlUHJveHkoZXAsIHBhdGguc2xpY2UoMCwgLTEpKTsKICAgICAgICB9CiAgICAgICAgY29uc3QgW2FyZ3VtZW50TGlzdCwgdHJhbnNmZXJhYmxlc10gPSBwcm9jZXNzQXJndW1lbnRzKHJhd0FyZ3VtZW50TGlzdCk7CiAgICAgICAgcmV0dXJuIHJlcXVlc3RSZXNwb25zZU1lc3NhZ2UoZXAsIHsKICAgICAgICAgIHR5cGU6ICJBUFBMWSIsCiAgICAgICAgICBwYXRoOiBwYXRoLm1hcCgocCkgPT4gcC50b1N0cmluZygpKSwKICAgICAgICAgIGFyZ3VtZW50TGlzdAogICAgICAgIH0sIHRyYW5zZmVyYWJsZXMpLnRoZW4oZnJvbVdpcmVWYWx1ZSk7CiAgICAgIH0sCiAgICAgIGNvbnN0cnVjdChfdGFyZ2V0LCByYXdBcmd1bWVudExpc3QpIHsKICAgICAgICB0aHJvd0lmUHJveHlSZWxlYXNlZChpc1Byb3h5UmVsZWFzZWQpOwogICAgICAgIGNvbnN0IFthcmd1bWVudExpc3QsIHRyYW5zZmVyYWJsZXNdID0gcHJvY2Vzc0FyZ3VtZW50cyhyYXdBcmd1bWVudExpc3QpOwogICAgICAgIHJldHVybiByZXF1ZXN0UmVzcG9uc2VNZXNzYWdlKGVwLCB7CiAgICAgICAgICB0eXBlOiAiQ09OU1RSVUNUIiwKICAgICAgICAgIHBhdGg6IHBhdGgubWFwKChwKSA9PiBwLnRvU3RyaW5nKCkpLAogICAgICAgICAgYXJndW1lbnRMaXN0CiAgICAgICAgfSwgdHJhbnNmZXJhYmxlcykudGhlbihmcm9tV2lyZVZhbHVlKTsKICAgICAgfQogICAgfSk7CiAgICByZXR1cm4gcHJveHkyOwogIH0KICBmdW5jdGlvbiBteUZsYXQoYXJyKSB7CiAgICByZXR1cm4gQXJyYXkucHJvdG90eXBlLmNvbmNhdC5hcHBseShbXSwgYXJyKTsKICB9CiAgZnVuY3Rpb24gcHJvY2Vzc0FyZ3VtZW50cyhhcmd1bWVudExpc3QpIHsKICAgIGNvbnN0IHByb2Nlc3NlZCA9IGFyZ3VtZW50TGlzdC5tYXAodG9XaXJlVmFsdWUpOwogICAgcmV0dXJuIFtwcm9jZXNzZWQubWFwKCh2KSA9PiB2WzBdKSwgbXlGbGF0KHByb2Nlc3NlZC5tYXAoKHYpID0+IHZbMV0pKV07CiAgfQogIGNvbnN0IHRyYW5zZmVyQ2FjaGUgPSAvKiBAX19QVVJFX18gKi8gbmV3IFdlYWtNYXAoKTsKICBmdW5jdGlvbiB0cmFuc2ZlcihvYmosIHRyYW5zZmVycykgewogICAgdHJhbnNmZXJDYWNoZS5zZXQob2JqLCB0cmFuc2ZlcnMpOwogICAgcmV0dXJuIG9iajsKICB9CiAgZnVuY3Rpb24gcHJveHkob2JqKSB7CiAgICByZXR1cm4gT2JqZWN0LmFzc2lnbihvYmosIHsgW3Byb3h5TWFya2VyXTogdHJ1ZSB9KTsKICB9CiAgZnVuY3Rpb24gdG9XaXJlVmFsdWUodmFsdWUpIHsKICAgIGZvciAoY29uc3QgW25hbWUsIGhhbmRsZXJdIG9mIHRyYW5zZmVySGFuZGxlcnMpIHsKICAgICAgaWYgKGhhbmRsZXIuY2FuSGFuZGxlKHZhbHVlKSkgewogICAgICAgIGNvbnN0IFtzZXJpYWxpemVkVmFsdWUsIHRyYW5zZmVyYWJsZXNdID0gaGFuZGxlci5zZXJpYWxpemUodmFsdWUpOwogICAgICAgIHJldHVybiBbCiAgICAgICAgICB7CiAgICAgICAgICAgIHR5cGU6ICJIQU5ETEVSIiwKICAgICAgICAgICAgbmFtZSwKICAgICAgICAgICAgdmFsdWU6IHNlcmlhbGl6ZWRWYWx1ZQogICAgICAgICAgfSwKICAgICAgICAgIHRyYW5zZmVyYWJsZXMKICAgICAgICBdOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gWwogICAgICB7CiAgICAgICAgdHlwZTogIlJBVyIsCiAgICAgICAgdmFsdWUKICAgICAgfSwKICAgICAgdHJhbnNmZXJDYWNoZS5nZXQodmFsdWUpIHx8IFtdCiAgICBdOwogIH0KICBmdW5jdGlvbiBmcm9tV2lyZVZhbHVlKHZhbHVlKSB7CiAgICBzd2l0Y2ggKHZhbHVlLnR5cGUpIHsKICAgICAgY2FzZSAiSEFORExFUiI6CiAgICAgICAgcmV0dXJuIHRyYW5zZmVySGFuZGxlcnMuZ2V0KHZhbHVlLm5hbWUpLmRlc2VyaWFsaXplKHZhbHVlLnZhbHVlKTsKICAgICAgY2FzZSAiUkFXIjoKICAgICAgICByZXR1cm4gdmFsdWUudmFsdWU7CiAgICB9CiAgfQogIGZ1bmN0aW9uIHJlcXVlc3RSZXNwb25zZU1lc3NhZ2UoZXAsIG1zZywgdHJhbnNmZXJzKSB7CiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHsKICAgICAgY29uc3QgaWQgPSBnZW5lcmF0ZVVVSUQoKTsKICAgICAgZXAuYWRkRXZlbnRMaXN0ZW5lcigibWVzc2FnZSIsIGZ1bmN0aW9uIGwoZXYpIHsKICAgICAgICBpZiAoIWV2LmRhdGEgfHwgIWV2LmRhdGEuaWQgfHwgZXYuZGF0YS5pZCAhPT0gaWQpIHsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgZXAucmVtb3ZlRXZlbnRMaXN0ZW5lcigibWVzc2FnZSIsIGwpOwogICAgICAgIHJlc29sdmUoZXYuZGF0YSk7CiAgICAgIH0pOwogICAgICBpZiAoZXAuc3RhcnQpIHsKICAgICAgICBlcC5zdGFydCgpOwogICAgICB9CiAgICAgIGVwLnBvc3RNZXNzYWdlKE9iamVjdC5hc3NpZ24oeyBpZCB9LCBtc2cpLCB0cmFuc2ZlcnMpOwogICAgfSk7CiAgfQogIGZ1bmN0aW9uIGdlbmVyYXRlVVVJRCgpIHsKICAgIHJldHVybiBuZXcgQXJyYXkoNCkuZmlsbCgwKS5tYXAoKCkgPT4gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogTnVtYmVyLk1BWF9TQUZFX0lOVEVHRVIpLnRvU3RyaW5nKDE2KSkuam9pbigiLSIpOwogIH0KICBjb25zdCBzaW1kID0gYXN5bmMgKCkgPT4gV2ViQXNzZW1ibHkudmFsaWRhdGUobmV3IFVpbnQ4QXJyYXkoWzAsIDk3LCAxMTUsIDEwOSwgMSwgMCwgMCwgMCwgMSwgNSwgMSwgOTYsIDAsIDEsIDEyMywgMywgMiwgMSwgMCwgMTAsIDEwLCAxLCA4LCAwLCA2NSwgMCwgMjUzLCAxNSwgMjUzLCA5OCwgMTFdKSk7CiAgY29uc3QgTE9BRElOR19FQUdFUiA9ICJlYWdlciI7CiAgY29uc3QgTE9BRElOR19MQVpZID0gImxhenkiOwogIGNvbnN0IFdBU01fRkVBVFVSRVMgPSB7CiAgICAic3N3IjogWyJzaW1kIl0sCiAgICAibWluaW1hcDIiOiBbInNpbWQiXQogIH07CiAgY29uc3QgYWlvbGkgPSB7CiAgICB0b29sczogW10sCiAgICBjb25maWc6IHt9LAogICAgZmlsZXM6IFtdLAogICAgYmFzZToge30sCiAgICBmczoge30sCiAgICBhc3luYyBpbml0KCkgewogICAgICBpZiAoYWlvbGkudG9vbHMubGVuZ3RoID09PSAwKQogICAgICAgIHRocm93ICJFeHBlY3RpbmcgYXQgbGVhc3QgMSB0b29sLiI7CiAgICAgIGNvbnN0IHRvb2xzVW5pcXVlID0gbmV3IFNldChhaW9saS50b29scy5tYXAoKHQpID0+IGAke3QudG9vbH0vJHt0LnByb2dyYW0gfHwgdC50b29sfWApKTsKICAgICAgaWYgKHRvb2xzVW5pcXVlLnNpemUgIT09IGFpb2xpLnRvb2xzLmxlbmd0aCkKICAgICAgICB0aHJvdyAiRm91bmQgZHVwbGljYXRlIHRvb2xzOyBjYW4gb25seSBoYXZlIGVhY2ggdG9vbC9wcm9ncmFtIGNvbWJpbmF0aW9uIGF0IG1vc3Qgb25jZS4iOwogICAgICBhaW9saS5iYXNlID0gYWlvbGkudG9vbHMuZmluZCgodCkgPT4gdC5yZWluaXQgIT09IHRydWUpOwogICAgICBpZiAoIWFpb2xpLmJhc2UpCiAgICAgICAgdGhyb3cgIkNvdWxkIG5vdCBmaW5kIGEgdG9vbCB3aXRoIGByZWluaXQ6IGZhbHNlYCB0byB1c2UgYXMgdGhlIGJhc2UgbW9kdWxlLiBUbyBmaXggdGhpcyBpc3N1ZSwgaW5jbHVkZSB0aGUgdG9vbCBgYmFzZS8xLjAuMGAgd2hlbiBpbml0aWFsaXppbmcgQWlvbGkuIjsKICAgICAgYWlvbGkuYmFzZS5pc0Jhc2VNb2R1bGUgPSB0cnVlOwogICAgICBhd2FpdCB0aGlzLl9zZXR1cChhaW9saS5iYXNlKTsKICAgICAgYXdhaXQgdGhpcy5faW5pdE1vZHVsZXMoKTsKICAgICAgYWlvbGkuX2xvZygiUmVhZHkiKTsKICAgICAgcmV0dXJuIHRydWU7CiAgICB9LAogICAgYXN5bmMgX2luaXRNb2R1bGVzKCkgewogICAgICBhd2FpdCBQcm9taXNlLmFsbChhaW9saS50b29scy5tYXAodGhpcy5fc2V0dXApKTsKICAgICAgYXdhaXQgdGhpcy5fc2V0dXBGUygpOwogICAgfSwKICAgIG1vdW50KGZpbGVzID0gW10pIHsKICAgICAgY29uc3QgZGlyRGF0YSA9IGAke2Fpb2xpLmNvbmZpZy5kaXJTaGFyZWR9JHthaW9saS5jb25maWcuZGlyRGF0YX1gOwogICAgICBjb25zdCBkaXJNb3VudGVkID0gYCR7YWlvbGkuY29uZmlnLmRpclNoYXJlZH0ke2Fpb2xpLmNvbmZpZy5kaXJNb3VudGVkfWA7CiAgICAgIGxldCB0b01vdW50RmlsZXMgPSBbXSwgdG9Nb3VudFVSTHMgPSBbXSwgbW91bnRlZFBhdGhzID0gW107CiAgICAgIGlmICghQXJyYXkuaXNBcnJheShmaWxlcykgJiYgIShmaWxlcyBpbnN0YW5jZW9mIEZpbGVMaXN0KSkKICAgICAgICBmaWxlcyA9IFtmaWxlc107CiAgICAgIGFpb2xpLl9sb2coYE1vdW50aW5nICR7ZmlsZXMubGVuZ3RofSBmaWxlc2ApOwogICAgICBmb3IgKGxldCBmaWxlIG9mIGZpbGVzKSB7CiAgICAgICAgaWYgKGZpbGUgaW5zdGFuY2VvZiBGaWxlIHx8IChmaWxlID09IG51bGwgPyB2b2lkIDAgOiBmaWxlLmRhdGEpIGluc3RhbmNlb2YgQmxvYiAmJiBmaWxlLm5hbWUgfHwgdHlwZW9mIChmaWxlID09IG51bGwgPyB2b2lkIDAgOiBmaWxlLmRhdGEpID09PSAic3RyaW5nIiAmJiBmaWxlLm5hbWUpIHsKICAgICAgICAgIGlmICh0eXBlb2YgKGZpbGUgPT0gbnVsbCA/IHZvaWQgMCA6IGZpbGUuZGF0YSkgPT09ICJzdHJpbmciKQogICAgICAgICAgICBmaWxlLmRhdGEgPSBuZXcgQmxvYihbZmlsZS5kYXRhXSwgeyB0eXBlOiAidGV4dC9wbGFpbiIgfSk7CiAgICAgICAgICB0b01vdW50RmlsZXMucHVzaChmaWxlKTsKICAgICAgICB9IGVsc2UgaWYgKGZpbGUubmFtZSAmJiBmaWxlLnVybCkgewogICAgICAgICAgdG9Nb3VudFVSTHMucHVzaChmaWxlKTsKICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWxlID09ICJzdHJpbmciICYmIGZpbGUuc3RhcnRzV2l0aCgiaHR0cCIpKSB7CiAgICAgICAgICBmaWxlID0geyB1cmw6IGZpbGUsIG5hbWU6IGZpbGUuc3BsaXQoIi8vIikucG9wKCkucmVwbGFjZSgvXC8vZywgIi0iKSB9OwogICAgICAgICAgdG9Nb3VudFVSTHMucHVzaChmaWxlKTsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgdGhyb3cgYENhbm5vdCBtb3VudCBmaWxlKHMpIHNwZWNpZmllZC4gTXVzdCBiZSBhIEZpbGUsIEJsb2IsIGEgVVJMIHN0cmluZywgb3IgeyBuYW1lOiAiZmlsZS50eHQiLCBkYXRhOiAic3RyaW5nIiB9LmA7CiAgICAgICAgfQogICAgICAgIG1vdW50ZWRQYXRocy5wdXNoKGZpbGUubmFtZSk7CiAgICAgIH0KICAgICAgdHJ5IHsKICAgICAgICBhaW9saS5mcy51bm1vdW50KGRpck1vdW50ZWQpOwogICAgICB9IGNhdGNoIChlKSB7CiAgICAgIH0KICAgICAgZm9yIChsZXQgZmlsZSBvZiB0b01vdW50VVJMcykKICAgICAgICBhaW9saS5mcy5jcmVhdGVMYXp5RmlsZShkaXJEYXRhLCBmaWxlLm5hbWUsIGZpbGUudXJsLCB0cnVlLCB0cnVlKTsKICAgICAgYWlvbGkuZmlsZXMgPSBhaW9saS5maWxlcy5jb25jYXQodG9Nb3VudEZpbGVzKTsKICAgICAgYWlvbGkuYmFzZS5tb2R1bGUuRlMubW91bnQoYWlvbGkuYmFzZS5tb2R1bGUuV09SS0VSRlMsIHsKICAgICAgICBmaWxlczogYWlvbGkuZmlsZXMuZmlsdGVyKChmKSA9PiBmIGluc3RhbmNlb2YgRmlsZSksCiAgICAgICAgYmxvYnM6IGFpb2xpLmZpbGVzLmZpbHRlcigoZikgPT4gKGYgPT0gbnVsbCA/IHZvaWQgMCA6IGYuZGF0YSkgaW5zdGFuY2VvZiBCbG9iKQogICAgICB9LCBkaXJNb3VudGVkKTsKICAgICAgdG9Nb3VudEZpbGVzLm1hcCgoZmlsZSkgPT4gewogICAgICAgIGNvbnN0IG9sZHBhdGggPSBgJHtkaXJNb3VudGVkfS8ke2ZpbGUubmFtZX1gOwogICAgICAgIGNvbnN0IG5ld3BhdGggPSBgJHtkaXJEYXRhfS8ke2ZpbGUubmFtZX1gOwogICAgICAgIHRyeSB7CiAgICAgICAgICBhaW9saS5mcy51bmxpbmsobmV3cGF0aCk7CiAgICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIH0KICAgICAgICBhaW9saS5fbG9nKGBDcmVhdGluZyBzeW1saW5rOiAke25ld3BhdGh9IC0tPiAke29sZHBhdGh9YCk7CiAgICAgICAgYWlvbGkuZnMuc3ltbGluayhvbGRwYXRoLCBuZXdwYXRoKTsKICAgICAgfSk7CiAgICAgIHJldHVybiBtb3VudGVkUGF0aHMubWFwKChwYXRoKSA9PiBgJHtkaXJEYXRhfS8ke3BhdGh9YCk7CiAgICB9LAogICAgYXN5bmMgZXhlYyhjb21tYW5kLCBhcmdzID0gbnVsbCkgewogICAgICBhaW9saS5fbG9nKGBFeGVjdXRpbmcgJWMke2NvbW1hbmR9JWMgYXJncz0ke2FyZ3N9YCwgImNvbG9yOmRhcmtibHVlOyBmb250LXdlaWdodDpib2xkIiwgIiIpOwogICAgICBpZiAoIWNvbW1hbmQpCiAgICAgICAgdGhyb3cgIkV4cGVjdGluZyBhIGNvbW1hbmQiOwogICAgICBsZXQgdG9vbE5hbWUgPSBjb21tYW5kOwogICAgICBpZiAoYXJncyA9PSBudWxsKSB7CiAgICAgICAgYXJncyA9IGNvbW1hbmQuc3BsaXQoIiAiKTsKICAgICAgICB0b29sTmFtZSA9IGFyZ3Muc2hpZnQoKTsKICAgICAgfQogICAgICBjb25zdCB0b29sID0gYWlvbGkudG9vbHMuZmluZCgodCkgPT4gewogICAgICAgIHZhciBfYTsKICAgICAgICBsZXQgdG1wVG9vbE5hbWUgPSB0b29sTmFtZTsKICAgICAgICBpZiAoKChfYSA9IHQgPT0gbnVsbCA/IHZvaWQgMCA6IHQuZmVhdHVyZXMpID09IG51bGwgPyB2b2lkIDAgOiBfYS5zaW1kKSA9PT0gdHJ1ZSkKICAgICAgICAgIHRtcFRvb2xOYW1lID0gYCR7dG1wVG9vbE5hbWV9LXNpbWRgOwogICAgICAgIHJldHVybiB0LnByb2dyYW0gPT0gdG1wVG9vbE5hbWU7CiAgICAgIH0pOwogICAgICBpZiAodG9vbCA9PSBudWxsKQogICAgICAgIHRocm93IGBQcm9ncmFtICR7dG9vbE5hbWV9IG5vdCBmb3VuZC5gOwogICAgICB0b29sLnN0ZG91dCA9ICIiOwogICAgICB0b29sLnN0ZGVyciA9ICIiOwogICAgICBpZiAodG9vbC5sb2FkaW5nID09IExPQURJTkdfTEFaWSkgewogICAgICAgIHRvb2wubG9hZGluZyA9IExPQURJTkdfRUFHRVI7CiAgICAgICAgYXdhaXQgdGhpcy5faW5pdE1vZHVsZXMoKTsKICAgICAgfQogICAgICB0cnkgewogICAgICAgIHRvb2wubW9kdWxlLmNhbGxNYWluKGFyZ3MpOwogICAgICB9IGNhdGNoIChlcnJvcikgewogICAgICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpOwogICAgICB9CiAgICAgIHRyeSB7CiAgICAgICAgdG9vbC5tb2R1bGUuRlMuY2xvc2UodG9vbC5tb2R1bGUuRlMuc3RyZWFtc1sxXSk7CiAgICAgICAgdG9vbC5tb2R1bGUuRlMuY2xvc2UodG9vbC5tb2R1bGUuRlMuc3RyZWFtc1syXSk7CiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIH0KICAgICAgdG9vbC5tb2R1bGUuRlMuc3RyZWFtc1sxXSA9IHRvb2wubW9kdWxlLkZTLm9wZW4oIi9kZXYvc3Rkb3V0IiwgInciKTsKICAgICAgdG9vbC5tb2R1bGUuRlMuc3RyZWFtc1syXSA9IHRvb2wubW9kdWxlLkZTLm9wZW4oIi9kZXYvc3RkZXJyIiwgInciKTsKICAgICAgbGV0IHJlc3VsdCA9IHsgc3Rkb3V0OiB0b29sLnN0ZG91dCwgc3RkZXJyOiB0b29sLnN0ZGVyciB9OwogICAgICBpZiAoYWlvbGkuY29uZmlnLnByaW50SW50ZXJsZWF2ZWQpCiAgICAgICAgcmVzdWx0ID0gdG9vbC5zdGRvdXQ7CiAgICAgIGlmICh0b29sLnJlaW5pdCA9PT0gdHJ1ZSkgewogICAgICAgIGF3YWl0IHRoaXMucmVpbml0KHRvb2wudG9vbCk7CiAgICAgIH0KICAgICAgcmV0dXJuIHJlc3VsdDsKICAgIH0sCiAgICBjYXQocGF0aCkgewogICAgICByZXR1cm4gYWlvbGkuX2ZpbGVvcCgiY2F0IiwgcGF0aCk7CiAgICB9LAogICAgbHMocGF0aCkgewogICAgICByZXR1cm4gYWlvbGkuX2ZpbGVvcCgibHMiLCBwYXRoKTsKICAgIH0sCiAgICBkb3dubG9hZChwYXRoKSB7CiAgICAgIHJldHVybiBhaW9saS5fZmlsZW9wKCJkb3dubG9hZCIsIHBhdGgpOwogICAgfSwKICAgIHB3ZCgpIHsKICAgICAgcmV0dXJuIGFpb2xpLmZzLmN3ZCgpOwogICAgfSwKICAgIGNkKHBhdGgpIHsKICAgICAgZm9yIChsZXQgdG9vbCBvZiBhaW9saS50b29scykgewogICAgICAgIGNvbnN0IG1vZHVsZSA9IHRvb2wubW9kdWxlOwogICAgICAgIGlmICghbW9kdWxlKQogICAgICAgICAgY29udGludWU7CiAgICAgICAgdG9vbC5tb2R1bGUuRlMuY2hkaXIocGF0aCk7CiAgICAgIH0KICAgIH0sCiAgICBta2RpcihwYXRoKSB7CiAgICAgIGFpb2xpLmZzLm1rZGlyKHBhdGgpOwogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0sCiAgICByZWFkKHsgcGF0aCwgbGVuZ3RoLCBmbGFnID0gInIiLCBvZmZzZXQgPSAwLCBwb3NpdGlvbiA9IDAgfSkgewogICAgICBjb25zdCBzdHJlYW0gPSBhaW9saS5mcy5vcGVuKHBhdGgsIGZsYWcpOwogICAgICBjb25zdCBidWZmZXIgPSBuZXcgVWludDhBcnJheShsZW5ndGgpOwogICAgICBhaW9saS5mcy5yZWFkKHN0cmVhbSwgYnVmZmVyLCBvZmZzZXQsIGxlbmd0aCwgcG9zaXRpb24pOwogICAgICBhaW9saS5mcy5jbG9zZShzdHJlYW0pOwogICAgICByZXR1cm4gYnVmZmVyOwogICAgfSwKICAgIHdyaXRlKHsgcGF0aCwgYnVmZmVyLCBmbGFnID0gIncrIiwgb2Zmc2V0ID0gMCwgcG9zaXRpb24gPSAwIH0pIHsKICAgICAgY29uc3Qgc3RyZWFtID0gYWlvbGkuZnMub3BlbihwYXRoLCBmbGFnKTsKICAgICAgYWlvbGkuZnMud3JpdGUoc3RyZWFtLCBidWZmZXIsIG9mZnNldCwgYnVmZmVyLmxlbmd0aCwgcG9zaXRpb24pOwogICAgICBhaW9saS5mcy5jbG9zZShzdHJlYW0pOwogICAgfSwKICAgIGFzeW5jIHJlaW5pdCh0b29sTmFtZSkgewogICAgICBjb25zdCB0b29sID0gYWlvbGkudG9vbHMuZmluZCgodCkgPT4gdC50b29sID09IHRvb2xOYW1lKTsKICAgICAgY29uc3QgcHdkID0gYWlvbGkuYmFzZS5tb2R1bGUuRlMuY3dkKCk7CiAgICAgIE9iamVjdC5hc3NpZ24odG9vbCwgdG9vbC5jb25maWcpOwogICAgICB0b29sLnJlYWR5ID0gZmFsc2U7CiAgICAgIGF3YWl0IHRoaXMuaW5pdCgpOwogICAgICBpZiAodG9vbC5pc0Jhc2VNb2R1bGUpCiAgICAgICAgdGhpcy5tb3VudCgpOwogICAgICB0aGlzLmNkKHB3ZCk7CiAgICB9LAogICAgX3N0ZGluVHh0OiAiIiwKICAgIF9zdGRpblB0cjogMCwKICAgIGdldCBzdGRpbigpIHsKICAgICAgcmV0dXJuIGFpb2xpLl9zdGRpblR4dDsKICAgIH0sCiAgICBzZXQgc3RkaW4odHh0ID0gIiIpIHsKICAgICAgYWlvbGkuX2xvZyhgU2V0dGluZyBzdGRpbiB0byAlYyR7dHh0fSVjYCwgImNvbG9yOmRhcmtibHVlIiwgIiIpOwogICAgICBhaW9saS5fc3RkaW5UeHQgPSB0eHQ7CiAgICAgIGFpb2xpLl9zdGRpblB0ciA9IDA7CiAgICB9LAogICAgYXN5bmMgX3NldHVwKHRvb2wpIHsKICAgICAgaWYgKHRvb2wucmVhZHkpCiAgICAgICAgcmV0dXJuOwogICAgICBhaW9saS5fbG9nKGBTZXR0aW5nIHVwICR7dG9vbC50b29sfSAoYmFzZSA9ICR7dG9vbC5pc0Jhc2VNb2R1bGUgPT09IHRydWV9KS4uLmApOwogICAgICB0b29sLmNvbmZpZyA9IE9iamVjdC5hc3NpZ24oe30sIHRvb2wpOwogICAgICBpZiAoIXRvb2wudXJsUHJlZml4KQogICAgICAgIHRvb2wudXJsUHJlZml4ID0gYCR7YWlvbGkuY29uZmlnLnVybENETn0vJHt0b29sLnRvb2x9LyR7dG9vbC52ZXJzaW9ufWA7CiAgICAgIGlmICghdG9vbC5wcm9ncmFtKQogICAgICAgIHRvb2wucHJvZ3JhbSA9IHRvb2wudG9vbDsKICAgICAgaWYgKCF0b29sLmZlYXR1cmVzKSB7CiAgICAgICAgdG9vbC5mZWF0dXJlcyA9IHt9OwogICAgICAgIGNvbnN0IHdhc21GZWF0dXJlcyA9IFdBU01fRkVBVFVSRVNbdG9vbC5wcm9ncmFtXSB8fCBbXTsKICAgICAgICBpZiAod2FzbUZlYXR1cmVzLmluY2x1ZGVzKCJzaW1kIikpIHsKICAgICAgICAgIGlmIChhd2FpdCBzaW1kKCkpIHsKICAgICAgICAgICAgdG9vbC5wcm9ncmFtICs9ICItc2ltZCI7CiAgICAgICAgICAgIHRvb2wuZmVhdHVyZXMuc2ltZCA9IHRydWU7CiAgICAgICAgICB9IGVsc2UgewogICAgICAgICAgICBhaW9saS5fbG9nKGBXZWJBc3NlbWJseSBTSU1EIGlzIG5vdCBzdXBwb3J0ZWQgaW4gdGhpcyBicm93c2VyOyB3aWxsIGxvYWQgbm9uLVNJTUQgdmVyc2lvbiBvZiAke3Rvb2wucHJvZ3JhbX0uYCk7CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9CiAgICAgIGlmICh0b29sLmlzQmFzZU1vZHVsZSkKICAgICAgICB0b29sLmxvYWRpbmcgPSBMT0FESU5HX0VBR0VSOwogICAgICBpZiAodG9vbC5sb2FkaW5nID09PSBMT0FESU5HX0xBWlkpIHsKICAgICAgICBhaW9saS5fbG9nKGBXaWxsIGxhenktbG9hZCAke3Rvb2wudG9vbH07IHNraXBwaW5nIGluaXRpYWxpemF0aW9uLmApOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBzZWxmLmltcG9ydFNjcmlwdHMoYCR7dG9vbC51cmxQcmVmaXh9LyR7dG9vbC5wcm9ncmFtfS5qc2ApOwogICAgICB0b29sLm1vZHVsZSA9IGF3YWl0IE1vZHVsZSh7CiAgICAgICAgdGhpc1Byb2dyYW06IHRvb2wucHJvZ3JhbSwKICAgICAgICBsb2NhdGVGaWxlOiAocGF0aCwgcHJlZml4KSA9PiBgJHt0b29sLnVybFByZWZpeH0vJHtwYXRofWAsCiAgICAgICAgc3RkaW46ICgpID0+IHsKICAgICAgICAgIGlmIChhaW9saS5fc3RkaW5QdHIgPCBhaW9saS5zdGRpbi5sZW5ndGgpCiAgICAgICAgICAgIHJldHVybiBhaW9saS5zdGRpbi5jaGFyQ29kZUF0KGFpb2xpLl9zdGRpblB0cisrKTsKICAgICAgICAgIGVsc2UgewogICAgICAgICAgICBhaW9saS5zdGRpbiA9ICIiOwogICAgICAgICAgICByZXR1cm4gbnVsbDsKICAgICAgICAgIH0KICAgICAgICB9LAogICAgICAgIHByaW50OiAodGV4dCkgPT4gewogICAgICAgICAgaWYgKGFpb2xpLmNvbmZpZy5wcmludFN0cmVhbSkgewogICAgICAgICAgICBwb3N0TWVzc2FnZSh7CiAgICAgICAgICAgICAgdHlwZTogImJpb3dhc20iLAogICAgICAgICAgICAgIHZhbHVlOiB7CiAgICAgICAgICAgICAgICBzdGRvdXQ6IHRleHQKICAgICAgICAgICAgICB9CiAgICAgICAgICAgIH0pOwogICAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgdG9vbC5zdGRvdXQgKz0gdGV4dCArICJcbiI7CiAgICAgICAgICB9CiAgICAgICAgfSwKICAgICAgICBwcmludEVycjogKHRleHQpID0+IHsKICAgICAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gYWlvbGkuY29uZmlnLnByaW50SW50ZXJsZWF2ZWQgPyAic3Rkb3V0IiA6ICJzdGRlcnIiOwogICAgICAgICAgaWYgKGFpb2xpLmNvbmZpZy5wcmludFN0cmVhbSkgewogICAgICAgICAgICBwb3N0TWVzc2FnZSh7CiAgICAgICAgICAgICAgdHlwZTogImJpb3dhc20iLAogICAgICAgICAgICAgIHZhbHVlOiB7CiAgICAgICAgICAgICAgICBbZGVzdGluYXRpb25dOiB0ZXh0CiAgICAgICAgICAgICAgfQogICAgICAgICAgICB9KTsKICAgICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIHRvb2xbZGVzdGluYXRpb25dICs9IHRleHQgKyAiXG4iOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgfSk7CiAgICAgIGNvbnN0IEZTID0gdG9vbC5tb2R1bGUuRlM7CiAgICAgIGlmICh0b29sLmlzQmFzZU1vZHVsZSkgewogICAgICAgIGFpb2xpLl9sb2coYFNldHRpbmcgdXAgJHt0b29sLnRvb2x9IHdpdGggYmFzZSBtb2R1bGUgZmlsZXN5c3RlbS4uLmApOwogICAgICAgIEZTLm1rZGlyKGFpb2xpLmNvbmZpZy5kaXJTaGFyZWQsIDUxMSk7CiAgICAgICAgRlMubWtkaXIoYCR7YWlvbGkuY29uZmlnLmRpclNoYXJlZH0vJHthaW9saS5jb25maWcuZGlyRGF0YX1gLCA1MTEpOwogICAgICAgIEZTLm1rZGlyKGAke2Fpb2xpLmNvbmZpZy5kaXJTaGFyZWR9LyR7YWlvbGkuY29uZmlnLmRpck1vdW50ZWR9YCwgNTExKTsKICAgICAgICBGUy5jaGRpcihgJHthaW9saS5jb25maWcuZGlyU2hhcmVkfS8ke2Fpb2xpLmNvbmZpZy5kaXJEYXRhfWApOwogICAgICAgIGFpb2xpLmZzID0gRlM7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgYWlvbGkuX2xvZyhgU2V0dGluZyB1cCAke3Rvb2wudG9vbH0gd2l0aCBmaWxlc3lzdGVtLi4uYCk7CiAgICAgICAgRlMubWtkaXIoYWlvbGkuY29uZmlnLmRpclNoYXJlZCk7CiAgICAgICAgRlMubW91bnQodG9vbC5tb2R1bGUuUFJPWFlGUywgewogICAgICAgICAgcm9vdDogYWlvbGkuY29uZmlnLmRpclNoYXJlZCwKICAgICAgICAgIGZzOiBhaW9saS5mcwogICAgICAgIH0sIGFpb2xpLmNvbmZpZy5kaXJTaGFyZWQpOwogICAgICAgIEZTLmNoZGlyKGFpb2xpLmZzLmN3ZCgpKTsKICAgICAgfQogICAgICB0b29sLnN0ZG91dCA9ICIiOwogICAgICB0b29sLnN0ZGVyciA9ICIiOwogICAgICB0b29sLnJlYWR5ID0gdHJ1ZTsKICAgIH0sCiAgICBhc3luYyBfc2V0dXBGUygpIHsKICAgICAgY29uc3QgZnNEc3QgPSBhaW9saS5mczsKICAgICAgZm9yIChsZXQgdG9vbCBvZiBhaW9saS50b29scykgewogICAgICAgIGlmICghdG9vbC5yZWFkeSkKICAgICAgICAgIGNvbnRpbnVlOwogICAgICAgIGNvbnN0IGZzU3JjID0gdG9vbC5tb2R1bGUuRlM7CiAgICAgICAgY29uc3QgcGF0aFNyYyA9IGAvJHt0b29sLnRvb2x9YDsKICAgICAgICBjb25zdCBwYXRoRHN0ID0gYCR7YWlvbGkuY29uZmlnLmRpclNoYXJlZH0ke3BhdGhTcmN9YDsKICAgICAgICBpZiAoIWZzU3JjLmFuYWx5emVQYXRoKHBhdGhTcmMpLmV4aXN0cyB8fCBmc0RzdC5hbmFseXplUGF0aChwYXRoRHN0KS5leGlzdHMpCiAgICAgICAgICBjb250aW51ZTsKICAgICAgICBhaW9saS5fbG9nKGBNb3VudGluZyAke3BhdGhTcmN9IG9udG8gJHthaW9saS5iYXNlLnRvb2x9IGZpbGVzeXN0ZW0gYXQgJHtwYXRoRHN0fWApOwogICAgICAgIGZzRHN0Lm1rZGlyKHBhdGhEc3QpOwogICAgICAgIGZzRHN0Lm1vdW50KGFpb2xpLmJhc2UubW9kdWxlLlBST1hZRlMsIHsKICAgICAgICAgIHJvb3Q6IHBhdGhTcmMsCiAgICAgICAgICBmczogZnNTcmMKICAgICAgICB9LCBwYXRoRHN0KTsKICAgICAgfQogICAgfSwKICAgIF9maWxlb3Aob3BlcmF0aW9uLCBwYXRoKSB7CiAgICAgIGFpb2xpLl9sb2coYFJ1bm5pbmcgJHtvcGVyYXRpb259ICR7cGF0aH1gKTsKICAgICAgY29uc3QgaW5mbyA9IGFpb2xpLmZzLmFuYWx5emVQYXRoKHBhdGgpOwogICAgICBpZiAoIWluZm8uZXhpc3RzKSB7CiAgICAgICAgYWlvbGkuX2xvZyhgRmlsZSAke3BhdGh9IG5vdCBmb3VuZC5gKTsKICAgICAgICByZXR1cm4gZmFsc2U7CiAgICAgIH0KICAgICAgc3dpdGNoIChvcGVyYXRpb24pIHsKICAgICAgICBjYXNlICJjYXQiOgogICAgICAgICAgcmV0dXJuIGFpb2xpLmZzLnJlYWRGaWxlKHBhdGgsIHsgZW5jb2Rpbmc6ICJ1dGY4IiB9KTsKICAgICAgICBjYXNlICJscyI6CiAgICAgICAgICBpZiAoYWlvbGkuZnMuaXNGaWxlKGluZm8ub2JqZWN0Lm1vZGUpKQogICAgICAgICAgICByZXR1cm4gYWlvbGkuZnMuc3RhdChwYXRoKTsKICAgICAgICAgIHJldHVybiBhaW9saS5mcy5yZWFkZGlyKHBhdGgpOwogICAgICAgIGNhc2UgImRvd25sb2FkIjoKICAgICAgICAgIGNvbnN0IGJsb2IgPSBuZXcgQmxvYihbdGhpcy5jYXQocGF0aCldKTsKICAgICAgICAgIHJldHVybiBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOwogICAgICB9CiAgICAgIHJldHVybiBmYWxzZTsKICAgIH0sCiAgICBfbG9nKG1lc3NhZ2UpIHsKICAgICAgaWYgKCFhaW9saS5jb25maWcuZGVidWcpCiAgICAgICAgcmV0dXJuOwogICAgICBsZXQgYXJncyA9IFsuLi5hcmd1bWVudHNdOwogICAgICBhcmdzLnNoaWZ0KCk7CiAgICAgIGNvbnNvbGUubG9nKGAlY1tXZWJXb3JrZXJdJWMgJHttZXNzYWdlfWAsICJmb250LXdlaWdodDpib2xkIiwgIiIsIC4uLmFyZ3MpOwogICAgfQogIH07CiAgZXhwb3NlKGFpb2xpKTsKfSkoKTsKLy8jIHNvdXJjZU1hcHBpbmdVUkw9YXNzZXRzL3dvcmtlci42OWE4Nzk3Yy5qcy5tYXA=";
const blob = typeof window !== "undefined" && window.Blob && new Blob([atob(encodedJs)], { type: "text/javascript;charset=utf-8" });
function WorkerWrapper() {
  const objURL = blob && (window.URL || window.webkitURL).createObjectURL(blob);
  try {
    return objURL ? new Worker(objURL) : new Worker("data:application/javascript;base64," + encodedJs);
  } finally {
    objURL && (window.URL || window.webkitURL).revokeObjectURL(objURL);
  }
}
const URL_CDN_ROOT = "https://biowasm.com/cdn/v3";
const URL_CDN_ROOT_STG = "https://stg.biowasm.com/cdn/v3";
const CONFIG_DEFAULTS = {
  urlCDN: URL_CDN_ROOT,
  urlCDNStg: URL_CDN_ROOT_STG,
  dirShared: "/shared",
  dirMounted: "/mnt",
  dirData: "/data",
  printInterleaved: true,
  printStream: false,
  callback: null,
  debug: false,
  env: "prd"
};
class Aioli {
  constructor(tools, config = {}) {
    if (tools == null)
      throw "Expecting array of tools as input to Aioli constructor.";
    if (!Array.isArray(tools))
      tools = [tools];
    config = Object.assign({}, CONFIG_DEFAULTS, config);
    tools = tools.map(this._parseTool);
    if (config.env === "stg")
      config.urlCDN = config.urlCDNStg;
    this.tools = tools;
    this.config = config;
    if (this.config.callback != null)
      this.callback = this.config.callback;
    delete this.config.callback;
    return this.init();
  }
  async init() {
    const worker = new WorkerWrapper();
    if (this.callback)
      worker.onmessage = (e) => {
        if (e.data.type === "biowasm")
          this.callback(e.data.value);
      };
    const aioli = wrap(worker);
    aioli.tools = this.tools;
    aioli.config = this.config;
    await aioli.init();
    return aioli;
  }
  _parseTool(tool) {
    if (typeof tool !== "string")
      return tool;
    const toolSplit = tool.split("/");
    if (toolSplit.length != 2 && toolSplit.length != 3)
      throw "Expecting '<tool>/<version>' or '<tool>/<program>/<version>'";
    return {
      tool: toolSplit[0],
      program: toolSplit.length == 3 ? toolSplit[1] : toolSplit[0],
      version: toolSplit[toolSplit.length - 1]
    };
  }
}
export {
  Aioli as default
};
//# sourceMappingURL=aioli.mjs.map
