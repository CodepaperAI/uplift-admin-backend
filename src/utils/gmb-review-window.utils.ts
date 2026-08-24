export const GMB_REVIEW_WINDOW_MONTHS = 6;

type GoogleReviewWithCreateTime = {
  createTime?: string | null;
};

export function getGmbReviewWindowStart(now = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - GMB_REVIEW_WINDOW_MONTHS);
  return cutoff;
}

export function getGoogleReviewCreateDate(
  review: GoogleReviewWithCreateTime,
): Date | null {
  if (!review.createTime) {
    return null;
  }

  const createdAt = new Date(review.createTime);
  return Number.isNaN(createdAt.getTime()) ? null : createdAt;
}

export function isGoogleReviewWithinWindow(
  review: GoogleReviewWithCreateTime,
  cutoff = getGmbReviewWindowStart(),
): boolean {
  const createdAt = getGoogleReviewCreateDate(review);
  return !createdAt || createdAt >= cutoff;
}

export function filterGoogleReviewsToWindow<T extends GoogleReviewWithCreateTime>(
  reviews: T[],
  cutoff = getGmbReviewWindowStart(),
): T[] {
  return reviews.filter((review) => isGoogleReviewWithinWindow(review, cutoff));
}

export function shouldStopGoogleReviewPagination(
  reviews: GoogleReviewWithCreateTime[],
  cutoff = getGmbReviewWindowStart(),
): boolean {
  return (
    reviews.length > 0 &&
    reviews.every((review) => {
      const createdAt = getGoogleReviewCreateDate(review);
      return Boolean(createdAt && createdAt < cutoff);
    })
  );
}
