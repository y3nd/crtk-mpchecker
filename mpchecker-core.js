const GRAFANA_URL = process.env.GRAFANA_URL || "https://gf.centipede-rtk.org";
const LIZMAP_URL = process.env.LIZMAP_URL || "https://map.centipede-rtk.org";
const DATASOURCE_UID = process.env.DATASOURCE_UID || "ef4dj94eoifpcf";
const DATASOURCE_ID = Number(process.env.DATASOURCE_ID || 24);
const LIST_CACHE_TTL_MS = Number(process.env.LIST_CACHE_TTL_MS || 60_000);

function normalizeMountpoint(mountpoint) {
  return String(mountpoint).trim().toUpperCase();
}

function debugLog(enabled, message) {
  if (enabled) {
    console.debug(message);
  }
}

function createCachedFetcher(label, ttlMs, debug, fetcher) {
  let cachedValue = null;
  let expiresAt = 0;
  let inFlightPromise = null;

  return async function getCachedValue() {
    const now = Date.now();

    if (cachedValue !== null && now < expiresAt) {
      debugLog(debug, `${label} cache hit`);
      return cachedValue;
    }

    if (inFlightPromise) {
      debugLog(debug, `${label} cache wait for in-flight refresh`);
      return inFlightPromise;
    }

    debugLog(debug, `${label} cache refresh`);
    inFlightPromise = (async () => {
      const value = await fetcher();
      cachedValue = value;
      expiresAt = Date.now() + ttlMs;
      return value;
    })();

    try {
      return await inFlightPromise;
    } finally {
      inFlightPromise = null;
    }
  };
}

function createMountpointChecker({ debug = false, cacheTtlMs = LIST_CACHE_TTL_MS } = {}) {
  async function grafFetchMountpoints() {
    const url = `${GRAFANA_URL}/api/ds/query?ds_type=grafana-postgresql-datasource&requestId=SQR102`;
    const now = Date.now().toString();
    const body = {
      queries: [
        {
          refId: "A",
          datasource: {
            type: "grafana-postgresql-datasource",
            uid: DATASOURCE_UID,
          },
          rawSql: `
          SELECT
            mp as "Mount Point"
          FROM grafpub.antenne_mp
          ORDER BY
            mp ASC;
        `,
          format: "table",
          datasourceId: DATASOURCE_ID,
          intervalMs: 60000,
          maxDataPoints: 320,
        },
      ],
      from: now,
      to: now,
    };

    const t1 = performance.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const t2 = performance.now();
    debugLog(debug, `Grafana request took ${Math.round(t2 - t1)} ms`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Grafana request failed: ${response.status} ${response.statusText}\n${text}`);
    }

    const json = await response.json();
    const values = json?.results?.A?.frames?.[0]?.data?.values?.[0];

    if (!Array.isArray(values)) {
      throw new Error("Unexpected Grafana response format: mountpoint list not found.");
    }

    return values
      .filter((value) => value != null)
      .map((value) => normalizeMountpoint(value));
  }

  async function lizFetchFeatureType(type) {
    const url = `${LIZMAP_URL}/index.php/lizmap/service?repository=cent&project=centipede&SERVICE=WFS&REQUEST=GetFeature&VERSION=1.0.0&OUTPUTFORMAT=GeoJSON&TYPENAME=${type}`;

    const t1 = performance.now();
    const response = await fetch(url);
    const t2 = performance.now();
    debugLog(debug, `Lizmap request for "${type}" took ${Math.round(t2 - t1)} ms`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Lizmap request failed: ${response.status} ${response.statusText}\n${text}`);
    }

    return response.json();
  }

  async function lizFetchMountpoints() {
    const types = ["basesrtk", "notdeclared"];
    const results = await Promise.all(types.map((type) => lizFetchFeatureType(type)));
    const mountpoints = new Set();

    for (const data of results) {
      if (!Array.isArray(data?.features)) {
        continue;
      }

      for (const feature of data.features) {
        const mountpoint = feature?.properties?.mp;
        if (mountpoint) {
          mountpoints.add(normalizeMountpoint(mountpoint));
        }
      }
    }

    return Array.from(mountpoints);
  }

  const getGrafMountpoints = createCachedFetcher("Grafana list", cacheTtlMs, debug, grafFetchMountpoints);
  const getLizMountpoints = createCachedFetcher("Lizmap list", cacheTtlMs, debug, lizFetchMountpoints);

  async function checkCaster(mountpoint) {
    const url = `https://crtk.net/${encodeURIComponent(String(mountpoint).trim())}`;

    const t1 = performance.now();
    try {
      const response = await fetch(url, { method: "HEAD" });
      const t2 = performance.now();
      debugLog(debug, `Caster check for "${mountpoint}" took ${Math.round(t2 - t1)} ms`);
      return !response.ok;
    } catch (error) {
      throw new Error(`Error checking caster for mountpoint "${mountpoint}": ${error.message}`);
    }
  }

  async function isMountpointAvailable(mountpoint) {
    const normalizedMountpoint = normalizeMountpoint(mountpoint);
    const t1 = performance.now();

    const [grafMountpoints, lizMountpoints, casterAvailable] = await Promise.all([
      getGrafMountpoints(),
      getLizMountpoints(),
      checkCaster(normalizedMountpoint),
    ]);

    const combinedMountpoints = new Set([...grafMountpoints, ...lizMountpoints]);
    const listAvailable = !combinedMountpoints.has(normalizedMountpoint);
    const available = listAvailable && casterAvailable;

    const t2 = performance.now();
    debugLog(debug, `Complete check for mountpoint "${mountpoint}" took ${Math.round(t2 - t1)} ms`);

    return available;
  }

  return {
    checkCaster,
    getGrafMountpoints,
    getLizMountpoints,
    isMountpointAvailable,
    normalizeMountpoint,
  };
}

module.exports = {
  createMountpointChecker,
  normalizeMountpoint,
};
