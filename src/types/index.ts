export interface BusinessBase {
  legalName: string;
  oib: string;
  address: string;
  city: string;
  directorFirstName: string;
  directorLastName: string;
  directorFullName: string;
  registeredActivity: string;
}

export interface GoogleData {
  rating: number;
  reviewCount: number;
  placeId: string;
  competitors: Array<{
    name: string;
    rating: number;
    reviewCount: number;
    placeId: string;
  }>;
}

export interface MetaAdData {
  isRunningAds: boolean;
  activeAdCount: number;
  adSamples: Array<{
    headline?: string;
    body?: string;
    imageUrl?: string;
    startDate?: string;
  }>;
  competitorAds: Array<{
    businessName: string;
    isRunningAds: boolean;
    activeAdCount: number;
  }>;
}

export interface GoogleAdsData {
  isRunningAds: boolean;
  adCount: number;
  competitorAds: Array<{
    businessName: string;
    isRunningAds: boolean;
    adCount: number;
  }>;
}

export interface AiAuditResult {
  queries: Array<{
    query: string;
    response: string;
    targetMentioned: boolean;
    targetPosition: number | null;
    competitorsMentioned: string[];
  }>;
  visibilityScore: number;
  topCompetitorInAI: string;
  verdict: 'INVISIBLE' | 'WEAK' | 'PRESENT' | 'DOMINANT';
}

export interface PipelineInput {
  companyWallUrl: string;
  niche: string;
  dryRun?: boolean;
  deploy?: boolean;
}

export interface PipelineOutput {
  business: BusinessBase;
  google: GoogleData;
  meta: MetaAdData;
  googleAds: GoogleAdsData;
  audit: AiAuditResult;
  slug: string;
  pdfPath?: string;
  landingPageUrl?: string;
}

export interface DossierData {
  slug: string;
  legalName: string;
  directorFullName: string;
  directorFirstName: string;
  directorLastName: string;
  niche: string;
  nicheLabel: string;
  city: string;

  targetRating: number;
  targetReviewCount: number;
  competitor1Name: string;
  competitor1Rating: number;
  competitor1ReviewCount: number;
  competitor2Name: string;
  competitor2Rating: number;
  competitor2ReviewCount: number;

  targetRunningAds: boolean;
  targetAdCount: number;
  competitor1RunningAds: boolean;
  competitor2RunningAds: boolean;

  targetRunningGoogleAds: boolean;
  targetGoogleAdCount: number;
  competitor1RunningGoogleAds: boolean;
  competitor2RunningGoogleAds: boolean;

  visibilityScore: number;
  verdict: string;
  topCompetitorInAI: string;
  bestAiQueryText: string;
  bestAiResponseText: string;

  landingPageUrl: string;

  caseStudyNiche: string;
  caseStudyResult: string;

  qrCodeBase64: string;
}

export type ClientStatus =
  | 'generated'
  | 'printed'
  | 'delivered'
  | 'called'
  | 'meeting'
  | 'signed'
  | 'dead';

export interface ClientRecord {
  id: number;
  slug: string;
  businessName: string;
  oib: string | null;
  directorFullName: string | null;
  niche: string;
  city: string;
  status: ClientStatus;
  pdfPath: string | null;
  landingPageUrl: string | null;
  visibilityScore: number | null;
  verdict: string | null;
  pageVisitedAt: string | null;
  pageVisitCount: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NicheRecord {
  id: number;
  slug: string;
  labelHR: string;
  videoUrl: string | null;
  exclusiveClientId: number | null;
  city: string;
}

export interface CaseStudyRecord {
  id: number;
  niche: string;
  city: string | null;
  resultMetric: string;
  isActive: number;
}
