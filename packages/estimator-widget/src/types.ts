export interface EstimatorConfig {
  /** Root of the mounted embed handlers, e.g. "https://adminigloo.com/api/estimator/embed". */
  baseUrl: string;
  /** The `esk_…` embed key issued for this tenant. */
  clientKey: string;
  /** Optional copy overrides. */
  title?: string;
  subtitle?: string;
}

export interface EmbedProduct {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  measurementMode: string;
  isEstimatable: boolean;
}

export interface EmbedOptionValue {
  id: string;
  label: string;
  priceModifier: number;
  isDefault: boolean;
}

export interface EmbedOption {
  id: string;
  name: string;
  values: EmbedOptionValue[];
}

export interface EmbedRange {
  sqFt: number;
  linearFt: number;
  units: number;
  subtotal: number;
  estimateLow: number;
  estimateHigh: number;
}

export interface EmbedTakeoff {
  sqFt: number | null;
  linearFt: number | null;
  units: number | null;
  confidence: string;
  summary: string;
  assumptions: string[];
}

export interface EmbedMeasurement {
  widthIn?: number;
  heightIn?: number;
  sqFt?: number;
  linearFt?: number;
  units?: number;
}
