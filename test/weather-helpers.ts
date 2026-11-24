import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type {
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { createWebTools } from "../src/web-tools.js";

export const FORECAST = {
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

export function mockFetch(routes: {
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

export function weatherTool(
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
