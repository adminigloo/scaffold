# @adminigloo/estimator-widget

## 0.1.1

### Patch Changes

- 91c7d58: Unit-mode products send their count in `quantity` only. Sending it as
  `measurement.units` as well billed a per-unit component quantity² times once
  the engine (estimator 0.2.0) scales per-unit parts by `units`. The widget also
  asks for a name and an email or phone before saving, matching the platform,
  which now refuses a lead nobody can call back — instead of failing with a
  generic error after the round trip.
