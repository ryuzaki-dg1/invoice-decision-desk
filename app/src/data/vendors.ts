import type { LedgerInvoice, Vendor } from "../types";

// Vendor master: the approved-supplier list with the bank account on file.
// Bank details here are what we pay to. An invoice asking us to pay anywhere
// else is the classic business-email-compromise fraud pattern.
export const VENDORS: Vendor[] = [
  {
    id: "V-001",
    name: "Acme Industrial Supply",
    aliases: ["Acme Industrial", "Acme Industrial Supply Co."],
    bankName: "First Midwest Bank",
    phone: "(216) 555-0190",
    bankAccount: "441022874821",
    status: "active",
  },
  {
    id: "V-002",
    name: "Northstar Logistics LLC",
    aliases: ["Northstar Logistics", "Northstar Freight"],
    bankName: "Chase",
    phone: "(219) 555-0177",
    bankAccount: "771300459912",
    status: "active",
  },
  {
    id: "V-003",
    name: "Bluepeak Components Inc.",
    aliases: ["Bluepeak Components", "BluePeak"],
    bankName: "Wells Fargo",
    phone: "(408) 555-0123",
    bankAccount: "309188201147",
    status: "active",
  },
  {
    id: "V-004",
    name: "Westwind Office Solutions",
    aliases: ["Westwind Office"],
    bankName: "US Bank",
    phone: "(612) 555-0161",
    bankAccount: "552019873310",
    status: "active",
  },
  {
    id: "V-005",
    name: "Sunridge Chemicals Ltd.",
    aliases: ["Sunridge Chemicals", "Sunridge Chem"],
    bankName: "PNC Bank",
    phone: "(225) 555-0142",
    bankAccount: "660412339085",
    status: "active",
  },
  {
    id: "V-006",
    name: "Rao Electrical Contractors",
    aliases: ["Rao Electricals", "Rao Electrical"],
    bankName: "Fifth Third Bank",
    phone: "(312) 555-0148",
    bankAccount: "218840096653",
    status: "active",
  },
];

// DEMO DATA: invoices already in the ERP before this system went live, each with a payment record (status "paid").
// Used for duplicate detection and to know how much of each PO is billed.
export const ERP_LEDGER: LedgerInvoice[] = [
  {
    vendorId: "V-001",
    vendor: "Acme Industrial Supply",
    invoiceNumber: "INV-1031",
    poId: "PO-2026-0119",
    total: 2140.0,
    issueDate: "2026-09-12",
    lineItems: [],
    status: "paid",
    source: "erp",
  },
  {
    vendorId: "V-002",
    vendor: "Northstar Logistics LLC",
    invoiceNumber: "INV-7712",
    poId: "PO-2026-0167",
    total: 5000.0,
    issueDate: "2026-10-20",
    lineItems: [
      { description: "Freight - Chicago to Dallas (full truckload)", quantity: 4, unitPrice: 1250.0, total: 5000.0 },
    ],
    status: "paid",
    source: "erp",
  },
  {
    vendorId: "V-005",
    vendor: "Sunridge Chemicals Ltd.",
    invoiceNumber: "SC-3371",
    poId: "PO-2026-0211",
    total: 3823.2,
    issueDate: "2026-10-14",
    lineItems: [
      { description: "Industrial solvent XR-4 (drum, 55gal)", quantity: 12, unitPrice: 295.0, total: 3540.0 },
    ],
    status: "paid",
    source: "erp",
  },
  {
    vendorId: "V-003",
    vendor: "Bluepeak Components Inc.",
    invoiceNumber: "INV-4468",
    poId: "PO-2026-0102",
    total: 9570.0,
    issueDate: "2026-09-03",
    lineItems: [],
    status: "paid",
    source: "erp",
  },
];
