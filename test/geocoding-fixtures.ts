// First recorded on 2026-11-24. Run npm run corpus:record to refresh the JSON
// responses and their recording date.
import fixture from "./geocoding-fixtures.json" with { type: "json" };

// Each key is the exact URL passed to fetch, including the language and any
// countryCode. The tool separately caches the resolved user input.
export const geocodingFixtures: Readonly<Record<string, object | undefined>> =
  fixture.responses;
