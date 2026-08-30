/**
 * The whole design system. Eight files, no component-library dependency.
 *
 * Everything here reads its colour from a token declared in app/globals.css and
 * nothing here declares a colour of its own. That is the property that lets
 * separate people build separate screens and still ship one product: to restyle
 * the app you edit the theme, not forty pages.
 */
export { Button, buttonClass, type ButtonProps, type ButtonVariant } from "./Button";
export { Card, CardBody, CardHeader } from "./Card";
export { PageHeader } from "./PageHeader";
export { Table, THead, TBody, TR, TH, TD } from "./Table";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { EmptyState } from "./EmptyState";
export { Notice, type NoticeTone } from "./Notice";
export { Field, Input, Select, Textarea } from "./Field";
export { cx } from "./cx";
