const REGULATED_TOPIC_PATTERN =
  /\b(?:addiction|alcohol|credit|diagnos(?:is|tic)|financial|health|immigration|insurance|investment|judicial|lawyer|legal|liquor|loan|medical|mortgage|physio(?:therapy)?|rehabilitation|spirits|tax|trading|visa)\b/i;

const REGULATED_BENEFITS_PATTERN =
  /\b(?:(?:disability|employee|government|health|insurance|medical|retirement|social security|tax|veteran) benefits?|benefits? eligibility)\b/i;

// "Health" describes condition/capacity in common device terminology. Strip
// only an explicit device-health phrase before applying the regulated-topic
// vocabulary; any separate medical, legal, financial, or regulated term still
// keeps the topic gated.
const DEVICE_HEALTH_PHRASE_PATTERN =
  /\b(?:(?:battery|device|phone|smartphone|iphone|ipad|tablet|laptop|computer|macbook)(?:['’]s)?\s+health|health\s+of\s+(?:(?:a|an|the|your|my)\s+)?(?:battery|device|phone|smartphone|iphone|ipad|tablet|laptop|computer|macbook))\b/gi;

const DEVICE_DIAGNOSTIC_PHRASE_PATTERN =
  /\b(?:(?:battery|device|phone|smartphone|iphone|ipad|tablet|laptop|computer|macbook)(?:\s+repair)?\s+diagnos(?:is|tic|tics)|diagnos(?:is|tic|tics)\s+(?:for|of)\s+(?:(?:a|an|the|your|my)\s+)?(?:battery|device|phone|smartphone|iphone|ipad|tablet|laptop|computer|macbook))\b/gi;

export function isRegulatedRecoveryTopic(keyword: string): boolean {
  const withoutDeviceTerms = keyword
    .replace(DEVICE_HEALTH_PHRASE_PATTERN, " ")
    .replace(DEVICE_DIAGNOSTIC_PHRASE_PATTERN, " ");
  return (
    REGULATED_TOPIC_PATTERN.test(withoutDeviceTerms) ||
    REGULATED_BENEFITS_PATTERN.test(withoutDeviceTerms)
  );
}
