Run `npm run corpus:record` to refresh the raw Open-Meteo responses for the URLs in `geocoding-fixtures.json`.
Review response shape warnings and any corpus failures before committing the refreshed fixtures.
The tests use these files offline, and CI never runs the recorder.
