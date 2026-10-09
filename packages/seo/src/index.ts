/**
 * @adminigloo/seo: pure builders, no React, no Next, no database.
 * `./react` adds the <JsonLd/> component; `./og` adds the share-image
 * template for next/og.
 */

export { SeoError, type SeoErrorCode } from "./errors.js";
export type { DateInput } from "./util.js";

export {
  defineSite,
  absoluteUrl,
  pageUrl,
  robotsHeader,
  type Site,
  type SiteInput,
  type ShareImageMeta,
  EXTRA_ROBOTS_DIRECTIVES,
  type ExtraRobotsDirective,
  type ShareImageInput,
} from "./site.js";

export { isIndexable, hostnameOf, type IndexableInput } from "./indexable.js";

export {
  definePaths,
  pathRule,
  normalizePath,
  pathCovers,
  CHANGE_FREQUENCIES,
  type ChangeFrequency,
  type PathList,
  type PathListInput,
  type PathRule,
  type PublicPath,
  type PublicPathInput,
} from "./paths.js";

export {
  pageMetadata,
  siteMetadata,
  brandTitle,
  type PageInput,
  type PageMetadata,
  type SiteMetadata,
  type PageOpenGraph,
  type PageTwitter,
  type OgImage,
  type RobotsMeta,
  type RobotsDirectives,
  type OpenGraphPageType,
} from "./metadata.js";

export {
  graph,
  jsonLd,
  ref,
  serializeJsonLd,
  jsonLdScript,
  jsonLdScriptProps,
  tryNode,
  unresolvedRefs,
  SCHEMA_CONTEXT,
  type JsonLdNode,
  type JsonLdGraph,
  type JsonLdDocument,
  type JsonLdInput,
  type Ref,
} from "./jsonld.js";

export {
  organization,
  webSite,
  webPage,
  collectionPage,
  speakable,
  breadcrumbList,
  product,
  softwareApplication,
  event,
  howTo,
  faqPage,
  article,
  blogPosting,
  itemList,
  person,
  place,
  touristAttraction,
  localBusiness,
  aggregateRatingFrom,
  organizationId,
  webSiteId,
  webPageId,
  breadcrumbId,
  personId,
  ORGANIZATION_TYPES,
  WEB_PAGE_TYPES,
  APPLICATION_CATEGORIES,
  SOFTWARE_TYPES,
  ARTICLE_TYPES,
  PLACE_TYPES,
  LOCAL_BUSINESS_TYPES,
  AVAILABILITIES,
  type OrganizationInput,
  type OrganizationType,
  type WebSiteInput,
  type WebPageInput,
  type WebPageType,
  type CollectionPageInput,
  type SpeakableSpecification,
  type BreadcrumbItemInput,
  type ProductInput,
  type OfferInput,
  type ShippingInput,
  type ReturnPolicyInput,
  type AggregateRatingInput,
  type ReviewInput,
  type Availability,
  type SoftwareApplicationInput,
  type SoftwareType,
  type ApplicationCategory,
  type EventInput,
  type EventLocationInput,
  type HowToInput,
  type FaqItemInput,
  type ArticleInput,
  type ArticleType,
  type ItemListInput,
  type PersonInput,
  type PlaceInput,
  type PlaceType,
  type TouristAttractionInput,
  type LocalBusinessInput,
  type LocalBusinessType,
  type OpeningHoursInput,
  type PostalAddressInput,
  type GeoInput,
  type ImageInput,
  type PartyInput,
  type RichResultOption,
} from "./schema.js";

export { ROBOTS_BOTS, ROBOTS_BOTS_SOURCE, BOT_KINDS, botListFingerprint, type BotKind, type RobotsBot } from "./bots.js";

export {
  robotsPolicy,
  robotsTxt,
  isAllowedByRobots,
  type Access,
  type RobotsPolicy,
  type RobotsPolicyOptions,
  type RobotsGroup,
  type RobotsRuleInput,
} from "./robots.js";

export {
  sitemapEntries,
  pathEntries,
  toNextSitemap,
  sitemapXml,
  sitemapIndexXml,
  splitSitemap,
  buildSitemaps,
  sitemapResponse,
  SITEMAP_MAX_URLS,
  SITEMAP_MAX_BYTES,
  type SitemapEntry,
  type SitemapEntryInput,
  type SitemapEntriesOptions,
  type SitemapFile,
  type SitemapSet,
  type SplitOptions,
} from "./sitemap.js";

export {
  llmsTxt,
  llmsFullTxt,
  llmsResponse,
  LLMS_TXT_MAX_BYTES,
  LLMS_FULL_MAX_BYTES,
  type LlmsRegistry,
  type LlmsSection,
  type LlmsItem,
  type LlmsPricingPlan,
  type LlmsFaqItem,
  type LlmsOptions,
  type LlmsDocument,
} from "./llms.js";

export {
  submitUrls,
  indexNowKeyFile,
  isIndexNowKey,
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_BATCH,
  type SubmitUrlsOptions,
  type IndexNowResult,
  type IndexNowBatch,
} from "./indexnow.js";
