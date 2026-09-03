/**
 * URL slug for a Know Your Rights card.
 *
 * Derived from the title once, at import, and then stored. The stored value is
 * what the route resolves against, so correcting a title later does not break
 * a URL that is already indexed or shared.
 *
 * Kept in its own module because both the seed script and the admin create
 * path need exactly the same function — two implementations that drift would
 * produce cards nobody can reach.
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 70)
    // A trailing hyphen from the 70-character cut reads as a typo in the URL.
    .replace(/-+$/, '')
}
