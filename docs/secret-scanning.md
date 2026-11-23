# Secret scanning

The `Secret scan` workflow runs Gitleaks on pushes, pull requests, and manual runs. Checkout fetches the full history. The scanner inspects commits reachable from `HEAD` and fails on a matching secret pattern. The script pins the Gitleaks image by version and digest, and the configuration extends the scanner's default rules.

Run the same check locally:

```sh
bash scripts/check-secrets.sh
```

The script needs Docker and mounts the checkout and Git directories read-only. It redacts detected values but may identify the rule, file, and line. The workflow needs no repository secrets.

`.gitignore` prevents many accidental additions of local environment files and private keys, but it does not protect files already committed. Treat a real credential found by a scan as exposed and revoke it with the provider. Deleting it in a later commit does not remove it from history.

The script reads the root `.gitleaks.toml`. Gitleaks automatically loads the root `.gitleaksignore`. Each line is a `commit:file:rule:line` fingerprint and excludes only that finding, not the rest of history. The synthetic token introduced in `test/job-completion-notify.test.ts` by `d7da85a` (`generic-api-key`, line 266) has such a fingerprint. The test now uses a letters-only placeholder that the default rule does not recognize as a secret; the historical value remains covered by the fingerprint.

A clean scan does not prove there are no secrets: Gitleaks relies on known patterns and heuristics. Update the image version and digest only after validating the new official image and confirming detection of a synthetic fixture.
