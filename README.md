# harcap-slowsim - Capture HAR with delay injection

This is a tool to measure web performance of a page with a delay injected for specified resource(s).
This can be used to pinpoint a bottleneck of a page, by analyzing result of multiple measurements.

# Usage
```
harcap-slowsim [-o harfile][-s screenshot][-m model][-d delay-in-ms] <basepage-URL> <delayed-URL-regexp...>
```
