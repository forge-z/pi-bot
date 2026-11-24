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
      country: "France",
      admin1: "Île-de-France Region",
    },
    {
      name: "Paris",
      latitude: 33.66094,
      longitude: -95.55551,
      country_code: "US",
      country: "United States",
      admin1: "Texas",
      admin2: "Lamar County",
    },
    {
      name: "Paris",
      latitude: -23.123,
      longitude: -47.456,
      country_code: "BR",
      country: "Brazil",
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

function mockFetch(routes: {
  geocoding?: object | ((url: URL) => object);
  forecast?: unknown;
}) {
  const urls: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.hostname === "geocoding-api.open-meteo.com")
      return Response.json(
        typeof routes.geocoding === "function"
          ? routes.geocoding(url)
          : (routes.geocoding ?? {}),
      );
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
    "https://geocoding-api.open-meteo.com/v1/search?name=Paris&count=5&language=en&format=json",
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
    /Weather forecast for Paris, São Paulo, Brazil \(-23\.12, -47\.46\)/,
  );
  assert.match(
    result.text,
    /Local time: 2026-11-24 14:15 \(America\/Sao_Paulo GMT-3\)/,
  );
  assert.match(
    result.text,
    /Now: partly cloudy, 27\.3 °C \(feels like 29\.1 °C\), humidity 61%, precipitation 0 mm, wind 11\.2 km\/h/,
  );
  assert.match(
    result.text,
    /- 2026-11-24 \(Tue\): light rain, 19\.2–30\.1 °C, rain 3\.2 mm \(70%\), wind up to 20\.4 km\/h/,
  );
  assert.match(
    result.text,
    /- 2026-11-25 \(Wed\): thunderstorm, 18\.6–28 °C, rain 12\.5 mm, wind up to 31 km\/h/,
  );
});

test("weather uses the qualifier after a comma to choose among matches", async () => {
  for (const [qualifier, queries, latitude, label] of [
    [
      "France",
      [["Paris, France", null]],
      "48.85",
      /Paris, Île-de-France Region, France/,
    ],
    ["FR", [["Paris", "FR"]], "48.85", /Paris, Île-de-France Region, France/],
    [
      "França",
      [
        ["Paris, França", null],
        ["Paris", "FR"],
      ],
      "48.85",
      /Paris, Île-de-France Region, France/,
    ],
    [
      "Franca",
      [
        ["Paris, Franca", null],
        ["Paris", "FR"],
      ],
      "48.85",
      /Paris, Île-de-France Region, France/,
    ],
    [
      "Frankreich",
      [
        ["Paris, Frankreich", null],
        ["Paris", "FR"],
      ],
      "48.85",
      /Paris, Île-de-France Region, France/,
    ],
    ["Texas", [["Paris, Texas", null]], "33.66", /Paris, Texas, United States/],
    [
      "Lamar County",
      [
        ["Paris, Lamar County", null],
        ["Paris", null],
      ],
      "33.66",
      /Paris, Texas, United States/,
    ],
  ] as const) {
    const { fetch, urls } = mockFetch({
      geocoding: (url) => {
        const name = url.searchParams.get("name");
        const code = url.searchParams.get("countryCode");
        if (name === "Paris, France" || code === "FR")
          return { results: GEOCODING.results.slice(0, 1) };
        if (name === "Paris, Texas")
          return { results: GEOCODING.results.slice(1, 2) };
        if (name === "Paris") return GEOCODING;
        return {};
      },
      forecast: FORECAST,
    });
    const result = await weatherTool(fetch)({
      location: `Paris, ${qualifier}`,
    });
    assert.equal(result.isError, false, qualifier);
    assert.deepEqual(
      urls
        .slice(0, -1)
        .map((url) => [
          url.searchParams.get("name"),
          url.searchParams.get("countryCode"),
        ]),
      queries,
      qualifier,
    );
    assert.equal(urls.at(-1)!.searchParams.get("latitude"), latitude);
    assert.equal(urls.at(-1)!.searchParams.get("forecast_days"), "5");
    assert.match(result.text, label);
  }
});

test("weather asks for disambiguation instead of using a city outside the qualifier", async () => {
  const { fetch, urls } = mockFetch({
    geocoding: (url) =>
      url.searchParams.get("name") === "Paris" ? GEOCODING : {},
    forecast: FORECAST,
  });
  const result = await weatherTool(fetch)({ location: "Paris, Not a State" });
  assert.equal(result.isError, true);
  assert.match(result.text, /Check the city and state or country/);
  assert.deepEqual(
    urls.map((url) => url.searchParams.get("name")),
    ["Paris, Not a State", "Paris"],
  );
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
  assert.match(first.text, /provided coordinates \(-25\.43, -49\.27\)/);
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

test("weather rejects incomplete forecasts without caching them", async () => {
  const responses = [
    { timezone: "UTC", daily: { time: [] } },
    { ...FORECAST, daily: undefined },
    { ...FORECAST, daily: { ...FORECAST.daily, time: [] } },
    { ...FORECAST, daily: { ...FORECAST.daily, weather_code: [61] } },
    { ...FORECAST, current: { ...FORECAST.current, temperature_2m: null } },
    {
      ...FORECAST,
      current: { ...FORECAST.current, apparent_temperature: null },
      daily: { ...FORECAST.daily, wind_speed_10m_max: [null, null] },
    },
  ];
  let requests = 0;
  const run = weatherTool(async () => Response.json(responses[requests++]));
  const args = { latitude: 0, longitude: 0, days: 2 };
  for (let i = 0; i < responses.length - 1; i++) {
    const result = await run(args);
    assert.equal(result.isError, true);
    assert.match(result.text, /forecast: invalid response/);
  }
  const valid = await run(args);
  assert.equal(valid.isError, false);
  assert.match(valid.text, /feels like \? °C/);
  assert.match(valid.text, /wind up to \? km\/h/);
  assert.deepEqual(await run(args), valid);
  assert.equal(requests, responses.length);
});

test("weather cancels a forecast stream at the response byte limit", async () => {
  let chunks = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      if (chunks <= 8) controller.enqueue(new Uint8Array(128 * 1024));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await weatherTool(async () => new Response(stream))({
    latitude: 0,
    longitude: 0,
  });
  assert.equal(result.isError, true);
  assert.equal(result.text, "weather failed (forecast: response too large).");
  assert.ok(cancelled);
  assert.ok(chunks < 8, "the remaining bytes are not consumed");
});
