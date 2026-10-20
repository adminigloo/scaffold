---
"@adminigloo/estimator-widget": minor
---

The showroom: the admin notices are one collapsed, dismissible "N things to finish" card; the operator's jobs (email, photo storage, photo reading) read as one plain sentence, with the server's technical words only for `showTechnical` (staff). `<Switch hint>` takes `{ on, off }` so the help always describes the current state ("Show on your website", "Give an instant price", "Take instant estimates", "Take photos"). `<EstimatesQueue>` and `<PriceBook>` take `title={false}` for a host page with its own header; the queue's first empty state says what it's for and links `estimatePageUrl`.
