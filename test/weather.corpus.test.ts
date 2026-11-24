import assert from "node:assert/strict";
import { test } from "node:test";
import { geocodingFixtures } from "./geocoding-fixtures.js";
import { FORECAST, mockFetch, weatherTool } from "./weather-helpers.js";

type Outcome =
  | { kind: "resolved"; name: string; region: string; country: string }
  | { kind: "ambiguous"; qualifier: "state" | "country"; regions: string[] }
  | { kind: "not found" };

type CorpusCase = {
  locations: string[];
  expected: Outcome;
  knownFailure?: true;
};

function resolved(
  locations: string[],
  name: string,
  region: string,
  country: string,
): CorpusCase {
  return { locations, expected: { kind: "resolved", name, region, country } };
}

function brazil(locations: string[], name: string, region: string): CorpusCase {
  return resolved(locations, name, region, "Brazil");
}

function ambiguous(
  qualifier: "state" | "country",
  ...regions: string[]
): Outcome {
  return { kind: "ambiguous", qualifier, regions };
}

const notFound = { kind: "not found" } as const;

const cases: CorpusCase[] = [
  brazil(
    ["Brasília", "Brasília, DF", "Brasília, Distrito Federal, Brasil"],
    "Brasília",
    "Federal District",
  ),
  brazil(
    ["Rio de Janeiro", "Rio de Janeiro, RJ"],
    "Rio de Janeiro",
    "Rio de Janeiro",
  ),
  brazil(["São Paulo", "São Paulo, SP"], "São Paulo", "São Paulo"),
  brazil(["Salvador", "Salvador, BA"], "Salvador", "Estado de Bahia"),
  brazil(
    ["Belo Horizonte", "Belo Horizonte, MG"],
    "Belo Horizonte",
    "Minas Gerais",
  ),
  {
    locations: ["Campo Grande"],
    expected: ambiguous("state", "MS", "SP", "RN"),
  },
  brazil(["Campo Grande, MS"], "Campo Grande", "Mato Grosso do Sul"),
  brazil(
    ["Porto Alegre", "Porto Alegre, RS"],
    "Porto Alegre",
    "Rio Grande do Sul",
  ),
  brazil(["Recife", "Recife, PE"], "Recife", "Pernambuco"),
  brazil(["Curitiba", "Curitiba, PR"], "Curitiba", "Paraná"),
  brazil(["Campinas", "Campinas, SP"], "Campinas", "São Paulo"),
  brazil(["Santos", "Santos, SP"], "Santos", "São Paulo"),
  brazil(["Goiânia", "Goiânia, GO"], "Goiânia", "Goiás"),
  brazil(["Fortaleza", "Fortaleza, CE"], "Fortaleza", "Ceará"),
  brazil(["Manaus", "Manaus, AM"], "Manaus", "Amazonas"),
  brazil(["Niterói", "Niterói, RJ"], "Niterói", "Rio de Janeiro"),
  brazil(["João Pessoa", "João Pessoa, PB, Brasil"], "João Pessoa", "Paraíba"),
  {
    locations: ["Campo Alegre", "Campo Alegre, BR"],
    expected: ambiguous("state", "AL", "SC"),
  },
  brazil(
    ["Campo Alegre, AL", "Campo Alegre, AL, Brasil"],
    "Campo Alegre",
    "Alagoas",
  ),
  brazil(
    ["Campo Alegre, SC", "Campo Alegre, SC, Brasil"],
    "Campo Alegre",
    "Santa Catarina",
  ),
  {
    locations: ["Toledo"],
    expected: ambiguous("country", "United States", "Brazil"),
  },
  // Known failure to resolve: even with Brazil selected, Toledo requires a state.
  {
    locations: ["Toledo, BR"],
    expected: ambiguous("state", "PR", "MG"),
    knownFailure: true,
  },
  brazil(["Toledo, PR", "Toledo, PR, Brasil"], "Toledo", "Paraná"),
  brazil(["Toledo, MG", "Toledo, MG, Brasil"], "Toledo", "Minas Gerais"),
  { locations: ["Cascavel"], expected: ambiguous("state", "PR", "CE") },
  brazil(["Cascavel, PR", "Cascavel, PR, Brasil"], "Cascavel", "Paraná"),
  brazil(["Cascavel, CE", "Cascavel, CE, Brasil"], "Cascavel", "Ceará"),

  resolved(
    [
      "Lisboa",
      "Lisboa, Portugal",
      "Lisboa, PT",
      "Lisboa, Distrito de Lisboa, Portugal",
    ],
    "Lisboa",
    "Distrito de Lisboa",
    "Portugal",
  ),
  // Known failures: the Portuguese district needs the country, and the English
  // name "Lisbon District" is unsupported even with Portugal given.
  {
    locations: [
      "Lisboa, Distrito de Lisboa",
      "Lisboa, Lisbon District, Portugal",
    ],
    expected: notFound,
    knownFailure: true,
  },
  resolved(["Porto", "Porto, Portugal"], "Porto", "Porto District", "Portugal"),

  resolved(["Madrid", "Madrid, Spain"], "Madrid", "Madrid", "Spain"),
  // Known failure: the Portuguese city alias is not found.
  { locations: ["Santiago do Chile"], expected: notFound, knownFailure: true },
  resolved(["Santiago, Chile"], "Santiago", "Santiago Metropolitan", "Chile"),
  resolved(
    ["Barcelona", "Barcelona, ES", "Barcelona, ES, Spain"],
    "Barcelona",
    "Catalonia",
    "Spain",
  ),
  // Known failure: Warszawa needs a country to reach the Polish lookup.
  { locations: ["Warszawa"], expected: notFound, knownFailure: true },
  resolved(
    ["Warszawa, PL", "Warszawa, Poland"],
    "Warszawa",
    "Województwo mazowieckie",
    "Polska",
  ),
  // Known failure: Bruxelles is not found, including with the BE qualifier.
  {
    locations: ["Bruxelles", "Bruxelles, BE"],
    expected: notFound,
    knownFailure: true,
  },
  resolved(["Brussels, BE"], "Brussels", "Brussels Capital", "Belgium"),
  {
    locations: ["Valencia"],
    expected: ambiguous("country", "Venezuela", "Spain"),
  },
  resolved(["Valencia, ES"], "Valencia", "Valencia", "Spain"),
  resolved(["Valencia, VE"], "Valencia", "Carabobo", "Venezuela"),
  {
    locations: ["Cambridge"],
    expected: ambiguous("country", "United Kingdom", "Canada", "United States"),
  },
  resolved(["Cambridge, GB"], "Cambridge", "England", "United Kingdom"),
  {
    locations: ["Cambridge, US"],
    expected: ambiguous(
      "state",
      "Massachusetts",
      "Maryland",
      "Ohio",
      "Minnesota",
      "Illinois",
    ),
  },
  {
    locations: ["Santa Cruz"],
    expected: ambiguous("country", "Spain", "Philippines"),
  },
  resolved(
    ["Santa Cruz, BO"],
    "Santa Cruz de la Sierra",
    "Santa Cruz Department",
    "Bolivia",
  ),
  resolved(["Paris", "Paris, FR"], "Paris", "Île-de-France Region", "France"),
  resolved(["Paris, Texas"], "Paris", "Texas", "United States"),
  {
    locations: [
      "Barcelona, ES, Brasil",
      "Paris, Texas, France",
      "João Pessoa, PE, Brasil",
    ],
    expected: notFound,
  },
];

function readOutcome(
  { isError, text }: { isError: boolean | undefined; text: string },
  location: string,
): Outcome {
  if (!isError) {
    const match =
      /^Weather forecast for ([^,\n]+), ([^,\n]+), ([^,\n]+) \([^\n]+\)$/m.exec(
        text,
      );
    assert.ok(match, text);
    const [, name, region, country] = match;
    return { kind: "resolved", name, region, country };
  }

  const miss = /^weather: location not found: ("[^"\n]+")\./m.exec(text);
  if (miss) {
    assert.equal(JSON.parse(miss[1]), location);
    return notFound;
  }

  const match =
    /^weather: "[^"\n]+" is ambiguous \(([^)\n]+)\)\. Pass the (state|country),/m.exec(
      text,
    );
  assert.ok(match, text);
  return ambiguous(
    match[2] === "state" ? "state" : "country",
    ...match[1].split(", "),
  );
}

for (const { locations, expected, knownFailure } of cases) {
  for (const location of locations) {
    test(`weather geocoding corpus: ${location}${knownFailure ? " (known failure)" : ""}`, async () => {
      const missing: string[] = [];
      const { fetch, urls } = mockFetch({
        geocoding: (url) => {
          const response = geocodingFixtures[url.href];
          if (response) return response;
          missing.push(url.href);
          throw new Error(`missing geocoding fixture for ${url.href}`);
        },
        forecast: FORECAST,
      });
      const result = await weatherTool(fetch)({ location });
      assert.deepEqual(missing, [], "missing geocoding fixtures");
      assert.deepEqual(readOutcome(result, location), expected);
      const forecasts = urls.filter(
        (url) => url.hostname === "api.open-meteo.com",
      );
      assert.equal(forecasts.length, expected.kind === "resolved" ? 1 : 0);
    });
  }
}
