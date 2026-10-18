import type { PermissionMap } from "@adminigloo/permissions";

/**
 * customers 0.1: THE CUSTOMER LIST — who the business's customers are, how
 * to reach them, and everything that is theirs. Two keys, in two ladders
 * (the store's pattern):
 *
 *   customersPermissions         one business, on the staff ladder (/admin/customers)
 *   customersCompanyPermissions  a company's own roles (/app/customers), in a
 *                                project where many companies share the app
 *
 * Not viewers: a customer list is names, addresses and phone numbers, the
 * most sensitive thing most businesses keep. Export is under manage: the
 * whole list in one file is a bigger thing to hand out than one card.
 */
export const customersPermissions = {
  "customers.view": {
    label: "See customers",
    description: "The customer list, each customer's details and notes, and everything that is theirs: quotes, visits, invoices, calls, orders and messages.",
    category: "Customers",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "customers.manage": {
    label: "Manage customers",
    description: "Add and change customers, their addresses and notes, merge two that are the same person, and import or export the list.",
    category: "Customers",
    defaultFor: ["admin", "cs_lead"],
  },
} as const satisfies PermissionMap;

export type CustomersPermission = keyof typeof customersPermissions;

export const customersCompanyPermissions = {
  "customers.view": {
    ...customersPermissions["customers.view"],
    description: "The company's customer list, each customer's details and notes, and their quotes, visits, invoices, calls, orders and messages.",
    defaultFor: ["owner", "admin", "member"],
  },
  "customers.manage": {
    ...customersPermissions["customers.manage"],
    defaultFor: ["owner", "admin"],
  },
} as const satisfies PermissionMap;
