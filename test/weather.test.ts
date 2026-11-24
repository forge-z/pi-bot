import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type {
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { createWebTools } from "../src/web-tools.js";

const GEOCODING = {
  results: [
    {
      name: "Paris",
      latitude: 48.85341,
      longitude: 2.3488,
      country_code: "FR",
      country: "França",
      admin1: "Ilha de França",
    },
    {
      name: "Paris",
      latitude: 33.66094,
      longitude: -95.55551,
      country_code: "US",
      country: "Estados Unidos",
      admin1: "Texas",
    },
    {
      name: "Paris",
      latitude: -23.123,
      longitude: -47.456,
      country_code: "BR",
      country: "Brasil",
      admin1: "São Paulo",
    },
  ],
  generationtime_ms: 0.5,
};

const FORECAST = {
  latitude: -23.125,
  longitude: -47.375,
  timezone: "America/Sao_Paulo",
  timezone_abbreviation: "GMT-3",
  utc_offset_seconds: -10800,
  current: {
    time: "2026-11-24T14:15",
    interval: 900,
    temperature_2m: 27.34,
    apparent_temperature: 29.1,
    relative_humidity_2m: 61,
    precipitation: 0,
    weather_code: 2,
    wind_speed_10m: 11.2,
  },
  daily: {
    time: ["2026-11-24", "2026-11-25"],
    weather_code: [61, 95],
    temperature_2m_max: [30.1, 28],
    temperature_2m_min: [19.2, 18.6],
    precipitation_sum: [3.2, 12.5],
    precipitation_probability_max: [70, null],
    wind_speed_10m_max: [20.4, 31],
  },
};

function mockFetch(routes: { geocoding?: unknown; forecast?: unknown }) {
  const urls: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.hostname === "geocoding-api.open-meteo.com")
      return Response.json(routes.geocoding ?? {});
    if (url.hostname === "api.open-meteo.com")
      return routes.forecast === undefined
        ? new Response("unavailable", { status: 503 })
        : Response.json(routes.forecast);
    throw new Error(`unexpected request ${url.href}`);
  };
  return { fetch, urls };
}

function weatherTool(
  fetch: typeof globalThis.fetch,
  now = () => 0,
  timeoutMs?: number,
) {
  const tools: readonly ToolRegistration[] = createWebTools(
    { search: [], extract: [] },
    {},
    { fetch, now, ...(timeoutMs ? { timeoutMs } : {}) },
  );
  const tool = tools.find((item) => item.name === "weather");
  assert.ok(tool, "weather is registered even without web providers");
  assert.equal(tool.replay, "safe");
  return async (args: object) => {
    const result = await tool.execute(args, {} as ToolExecutionApi, context);
    assert.ok("output" in result);
    const part = result.output?.[0];
    assert.ok(part?.type === "text");
    return { isError: result.isError, text: part.text };
  };
}

test("weather geocodes a city, prefers Brazil and summarizes the forecast", async () => {
  const { fetch, urls } = mockFetch({
    geocoding: GEOCODING,
    forecast: FORECAST,
  });
  const run = weatherTool(fetch);
  const result = await run({ location: "  Paris ", days: 2 });
  assert.equal(result.isError, false);

  const [geocoding, forecast] = urls;
  assert.equal(urls.length, 2);
  assert.equal(
    geocoding!.href,
    "https://geocoding-api.open-meteo.com/v1/search?name=Paris&count=5&language=pt&format=json",
  );
  assert.equal(
    forecast!.origin + forecast!.pathname,
    "https://api.open-meteo.com/v1/forecast",
  );
  assert.deepEqual(Object.fromEntries(forecast!.searchParams), {
    latitude: "-23.12",
    longitude: "-47.46",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
    current:
      "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    timezone: "auto",
    forecast_days: "2",
  });

  assert.match(result.text, /^<untrusted_tool_result source="weather">/);
  assert.match(result.text, /<\/untrusted_tool_result>$/);
  assert.ok(!result.text.trimStart().startsWith("{"), "not raw JSON");
  assert.match(
    result.text,
    /Previsão do tempo para Paris, São Paulo, Brasil \(-23\.12, -47\.46\)/,
  );
  assert.match(
    result.text,
    /Hora local: 2026-11-24 14:15 \(America\/Sao_Paulo GMT-3\)/,
  );
  assert.match(
    result.text,
    /Agora: parcialmente nublado, 27\.3 °C \(sensação 29\.1 °C\), umidade 61%, precipitação 0 mm, vento 11\.2 km\/h/,
  );
  assert.match(
    result.text,
    /- 2026-11-24 \(ter\): chuva fraca, 19\.2–30\.1 °C, chuva 3\.2 mm \(70%\), vento até 20\.4 km\/h/,
  );
  assert.match(
    result.text,
    /- 2026-11-25 \(qua\): trovoada, 18\.6–28 °C, chuva 12\.5 mm, vento até 31 km\/h/,
  );
});

test("weather uses the qualifier after a comma to choose among matches", async () => {
  const { fetch, urls } = mockFetch({
    geocoding: GEOCODING,
    forecast: FORECAST,
  });
  const result = await weatherTool(fetch)({ location: "Paris, Franca" });
  assert.equal(result.isError, false);
  assert.equal(urls[0]!.searchParams.get("name"), "Paris");
  assert.equal(urls[1]!.searchParams.get("latitude"), "48.85");
  assert.equal(urls[1]!.searchParams.get("forecast_days"), "5");
  assert.match(result.text, /Paris, Ilha de França, França/);
});

test("weather picks the first result when there is no Brazilian match", async () => {
  const { fetch, urls } = mockFetch({
    geocoding: { results: GEOCODING.results.slice(0, 2) },
    forecast: FORECAST,
  });
  const result = await weatherTool(fetch)({ location: "Paris" });
  assert.equal(result.isError, false);
  assert.equal(urls[1]!.searchParams.get("latitude"), "48.85");
});

test("weather accepts coordinates without geocoding and caches by rounded coordinates", async () => {
  const { fetch, urls } = mockFetch({ forecast: FORECAST });
  let now = 1_000;
  const run = weatherTool(fetch, () => now);
  const first = await run({ latitude: -25.4284, longitude: -49.2733, days: 3 });
  assert.equal(first.isError, false);
  assert.match(first.text, /coordenadas informadas \(-25\.43, -49\.27\)/);
  assert.equal(urls.length, 1);
  assert.equal(urls[0]!.hostname, "api.open-meteo.com");

  await run({ latitude: -25.4291, longitude: -49.2729, days: 3 });
  assert.equal(urls.length, 1, "same rounded coordinates hit the cache");
  await run({ latitude: -25.4284, longitude: -49.2733, days: 4 });
  assert.equal(urls.length, 2, "different days is a different cache key");
  now += 10 * 60_000 + 1;
  await run({ latitude: -25.4284, longitude: -49.2733, days: 3 });
  assert.equal(urls.length, 3, "entries expire after ten minutes");
});

test("weather reports a location that does not resolve", async () => {
  for (const geocoding of [{ generationtime_ms: 0.1 }, { results: [] }]) {
    const { fetch, urls } = mockFetch({ geocoding, forecast: FORECAST });
    const result = await weatherTool(fetch)({ location: "Xyzzyville" });
    assert.equal(result.isError, true);
    assert.match(result.text, /location not found: "Xyzzyville"/);
    assert.equal(urls.length, 1, "no forecast request");
  }
});

test("weather rejects missing locations and invalid days without requests", async () => {
  const { fetch, urls } = mockFetch({
    geocoding: GEOCODING,
    forecast: FORECAST,
  });
  const run = weatherTool(fetch);
  for (const args of [{}, { location: "   " }, { days: 3 }]) {
    const result = await run(args);
    assert.equal(result.isError, true);
    assert.match(result.text, /location name or latitude and longitude/);
  }
  const half = await run({ latitude: -25 });
  assert.equal(half.isError, true);
  assert.match(half.text, /both latitude and longitude/);
  for (const days of [0, 17, 2.5, -1]) {
    const result = await run({ location: "Curitiba", days });
    assert.equal(result.isError, true);
    assert.match(result.text, /days must be an integer from 1 to 16/);
  }
  const far = await run({ latitude: 91, longitude: 0 });
  assert.equal(far.isError, true);
  assert.match(far.text, /latitude must be between -90 and 90/);
  assert.equal(urls.length, 0);
});

test("weather turns HTTP failures and timeouts into short errors", async () => {
  const { fetch } = mockFetch({ geocoding: GEOCODING });
  const failed = await weatherTool(fetch)({ location: "Paris" });
  assert.equal(failed.isError, true);
  assert.equal(failed.text, "weather failed (forecast: HTTP 503).");

  const hanging: typeof globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal!.reason),
      ),
    );
  const timedOut = await weatherTool(
    hanging,
    undefined,
    10,
  )({ latitude: 0, longitude: 0 });
  assert.equal(timedOut.isError, true);
  assert.equal(timedOut.text, "weather failed (forecast: timed out).");
});
