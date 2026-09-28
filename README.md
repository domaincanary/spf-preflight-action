# DomainCanary SPF pre-flight

Fail a pull request when a change to your SPF record would stop a sender that still sends mail
from passing SPF. It's for teams that keep DNS in a repository: DNSControl, octoDNS, Terraform or
a plain file.

The action sends the proposed record to [DomainCanary](https://domaincanary.com/tools/spf-change-check),
which resolves both the published record and the proposed one and compares them.

- **Without an API key** it checks syntax, the 10-lookup limit, a `+all` ending, and which
  addresses the change removes. A removed range is a warning, because there's no way to tell
  from DNS alone whether anything still sends from it.
- **With an API key** it also checks each removed range against the senders in your DMARC reports
  from the last 90 days, and fails the check when one of them sent mail. The domain has to be
  verified in your DomainCanary account. Keys work on every plan, including the free plan;
  create one at <https://domaincanary.com/dashboard/account#api-key>.

## Usage

```yaml
on:
  pull_request:
    paths: ["dns/**"]

jobs:
  spf:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # only for comment: true
    steps:
      - uses: actions/checkout@v4
      - id: record
        run: echo "spf=$(cat dns/spf.txt)" >> "$GITHUB_OUTPUT"
      - uses: domaincanary/spf-preflight-action@v1
        with:
          domain: example.com
          record: ${{ steps.record.outputs.spf }}
          api-key: ${{ secrets.DOMAINCANARY_API_KEY }}
          comment: true
```

| Input | Required | Default | |
| --- | --- | --- | --- |
| `domain` | yes | | The domain the record is for. |
| `record` | yes | | The proposed record, starting with `v=spf1`. Quoted chunks as a DNS panel shows them are fine. |
| `api-key` | no | | A DomainCanary API key. Store it as a secret. |
| `comment` | no | `false` | Post the result as a pull request comment. Needs `pull-requests: write`. |
| `fail-on-warn` | no | `false` | Fail on a warning as well as on an error. |

The `verdict` output is `pass`, `warn`, `fail` or `unchanged`. The check fails on `fail`, and on
any answer other than a verdict (the service unreachable, a rate limit, a revoked key), so a
problem on our side never turns into a green check.

The key belongs to your whole account. If a public repository's secret ever leaks, revoke it from
the account page and create a new one.

## Getting the proposed record out of your DNS tool

The action takes the record as text and doesn't read any tool's files. Add a step before it that
prints the proposed record. These recipes have not yet been tried against a real repository.

**octoDNS**

```sh
yq '.[""][] | select(.type == "TXT") | .values[]? // .value' zones/example.com.yaml | grep '^v=spf1'
```

**DNSControl**

```sh
dnscontrol print-ir --pretty | jq -r '.. | .target? // empty | select(startswith("v=spf1"))'
```

**Terraform**

```sh
terraform show -json plan.out \
  | jq -r '.resource_changes[] | .change.after | select(.type? == "TXT") | (.records // [.value])[] | select(startswith("v=spf1"))'
```

**A plain file**

```sh
cat dns/spf.txt
```

## GitLab, Bitbucket and anything else

The action is a thin wrapper around one HTTP call:

```sh
curl -s -X POST https://domaincanary.com/api/v1/spf-preflight \
  -H "Authorization: Bearer $DOMAINCANARY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com", "record": "v=spf1 include:_spf.google.com -all"}'
```

## Development

```sh
deno test --no-config tests/
```

MIT licensed.
