/**
 * @adminigloo/dashboard: the staff dashboard.
 *
 *   createDashboardHandlers   the routes: the cards on offer, each person's layout, the cards' contents
 *   DashboardWidget           one card an app offers (key, page, permission, and the glance that fills it)
 *   Glance                    what a card shows, as data
 *   layout functions          the rules for arranging cards, shared by the browser and the server
 *
 *   @adminigloo/dashboard/schema         the dashboard_layouts table
 *   @adminigloo/dashboard/ui             <Dashboard />, the page itself
 *   @adminigloo/dashboard/glances/<pkg>  ready-made glances for each AdminIgloo feature
 */
export {
  ago,
  clampGlance,
  daySeries,
  plural,
  GLANCE_LIMITS,
  TONES,
  type Glance,
  type GlanceRow,
  type GlanceSpark,
  type GlanceTile,
  type Tone,
} from "./glance.js";
export {
  CARD_SIZES,
  MAX_CARDS,
  defaultLayout,
  drawOrder,
  isCardSize,
  moveCard,
  normalizeLayout,
  resizeCard,
  starCard,
  toggleCard,
  type CardSize,
  type DashboardLayout,
  type LayoutCatalogEntry,
  type LayoutItem,
} from "./layout.js";
export {
  DEFAULT_REFRESH_SECONDS,
  ICON_NAMES,
  checkWidgets,
  toCatalogCard,
  type BoardResponse,
  type CatalogCard,
  type DashboardWidget,
  type GlanceContext,
  type GlanceResult,
  type GlancesResponse,
  type IconName,
} from "./widget.js";
export {
  createDashboardHandlers,
  type DashboardDb,
  type DashboardHandlersOptions,
  type DashboardViewer,
} from "./handlers.js";
