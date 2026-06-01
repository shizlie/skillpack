const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

const _compileCache = new Map();
function compilePattern(pattern) {
  const cached = _compileCache.get(pattern);
  if (cached) return cached;
  const segments = pattern.split("/");
  const compiled = segments.map((segment) => {
    const paramMatch = PARAM_RE.exec(segment);
    return paramMatch ? { kind: "param", name: paramMatch[1] } : { kind: "lit", value: segment };
  });
  const fn = (path) => {
    const actual = path.split("/");
    if (actual.length !== compiled.length) return null;
    const params = {};
    for (let i = 0; i < compiled.length; i += 1) {
      const c = compiled[i];
      if (c.kind === "lit") {
        if (c.value !== actual[i]) return null;
      } else {
        let decoded;
        try { decoded = decodeURIComponent(actual[i]); } catch { return null; }
        params[c.name] = decoded;
      }
    }
    return params;
  };
  _compileCache.set(pattern, fn);
  return fn;
}

export function matchRoute(pattern, path) {
  const compiled = compilePattern(pattern);
  const params = compiled(path);
  if (params === null) return { matches: false, params: null };
  return { matches: true, params };
}
