import { launchStealthBrowser } from "../utils/browser.utils";
import {
  retrieveContextDevBrand,
  type ContextDevBrandProfile,
} from "./context-dev-brand.service";

export type BrandAnalysisSource =
  | "context.dev.brand.retrieve+website"
  | "context.dev.brand.retrieve"
  | "website"
  | "default";

export interface BrandData {
  primaryColors: string[];
  secondaryColors: string[];
  fontFamily?: string;
  logoUrl?: string;
  logoAltText?: string;
  faviconUrl?: string;
  referenceImageUrl?: string;
  analysisSource?: BrandAnalysisSource;
}

export interface ScrapedData {
  title: string;
  metaTags: Array<{ name: string | null; content: string | null }>;
  extractedColors: string[];
  extractedFonts: string[];
  headerColors: string[];
  logoInfo: {
    url: string | null;
    alt: string | null;
  };
  faviconUrl: string | null;
  blogImages: Array<{
    url: string;
    alt: string | null;
    blogUrl: string;
    blogTitle: string;
    width: number | null;
    height: number | null;
    type: string;
  }>;
}

/**
 * Context.dev is authoritative for normalized identity assets while the local
 * website pass remains useful for typography and blog imagery. Keeping this
 * merge pure makes the same precedence testable for every onboarding path.
 */
export function mergeBrandAnalysisSources(
  websiteBrand: BrandData,
  contextBrand: ContextDevBrandProfile | null,
): BrandData {
  if (!contextBrand) {
    return {
      ...websiteBrand,
      analysisSource: websiteBrand.analysisSource ?? "website",
    };
  }

  return {
    primaryColors:
      contextBrand.primaryColors.length > 0
        ? contextBrand.primaryColors
        : websiteBrand.primaryColors,
    secondaryColors:
      contextBrand.secondaryColors.length > 0
        ? contextBrand.secondaryColors
        : websiteBrand.secondaryColors,
    fontFamily: websiteBrand.fontFamily,
    logoUrl: contextBrand.logoUrl ?? websiteBrand.logoUrl,
    logoAltText:
      contextBrand.logoAltText ?? websiteBrand.logoAltText ?? undefined,
    faviconUrl: contextBrand.faviconUrl ?? websiteBrand.faviconUrl,
    referenceImageUrl:
      contextBrand.referenceImageUrl ?? websiteBrand.referenceImageUrl,
    analysisSource: "context.dev.brand.retrieve+website",
  };
}

export class BrandAnalysisService {
  async analyzeBrand(websiteUrl: string): Promise<BrandData & { blogImages?: ScrapedData['blogImages'] }> {
    const contextBrandPromise = retrieveContextDevBrand(websiteUrl);
    try {
      console.log(`🔍 Starting enhanced brand analysis for: ${websiteUrl}`);

      const [scrapedData, contextBrand] = await Promise.all([
        this.scrapeWebsiteOptimized(websiteUrl),
        contextBrandPromise,
      ]);

      const websiteBrand: BrandData = {
        primaryColors: this.extractPrimaryColors(scrapedData),
        secondaryColors: this.extractSecondaryColors(scrapedData),
        fontFamily: this.extractPrimaryFont(scrapedData),
        logoUrl: scrapedData.logoInfo.url || undefined,
        logoAltText: scrapedData.logoInfo.alt || undefined,
        faviconUrl: scrapedData.faviconUrl || undefined,
        analysisSource: "website",
      };
      const brandData: BrandData & { blogImages?: ScrapedData['blogImages'] } = {
        ...mergeBrandAnalysisSources(websiteBrand, contextBrand),
        blogImages: scrapedData.blogImages || [],
      };

      console.log(`✅ Brand analysis completed for: ${websiteUrl}`);
      console.log(`   - Logo: ${brandData.logoUrl || "not found"}`);
      console.log(`   - Primary Colors: ${brandData.primaryColors.join(", ")}`);
      console.log(`   - Favicon: ${brandData.faviconUrl || "not found"}`);
      console.log(`   - Blog Images: ${brandData.blogImages?.length || 0} extracted`);

      return brandData;
    } catch (error) {
      console.error(`❌ Brand analysis failed for ${websiteUrl}:`, error);

      const contextBrand = await contextBrandPromise;
      if (contextBrand) {
        return {
          primaryColors: contextBrand.primaryColors,
          secondaryColors: contextBrand.secondaryColors,
          logoUrl: contextBrand.logoUrl ?? undefined,
          logoAltText: contextBrand.logoAltText ?? undefined,
          faviconUrl: contextBrand.faviconUrl ?? undefined,
          referenceImageUrl: contextBrand.referenceImageUrl ?? undefined,
          analysisSource: "context.dev.brand.retrieve",
          blogImages: [],
        };
      }

      // Return default brand data if analysis fails
      return this.getDefaultBrandData();
    }
  }

  private async scrapeWebsiteOptimized(url: string): Promise<ScrapedData> {
    const browser = await launchStealthBrowser();

    const page = await browser.newPage();

    // Set a reasonable timeout
    page.setDefaultTimeout(15000);

    try {
      // Use faster loading strategy - domcontentloaded instead of networkidle2
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      // Wait a bit for dynamic content to load (using Promise instead of deprecated waitForTimeout)
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const data = await page.evaluate(() => {
        console.log('🔍 Starting in-browser extraction...');

        // ============================================
        // 1. LOGO EXTRACTION (Multiple Strategies)
        // ============================================
        const logoInfo = (() => {
          // Strategy 1: Look for common logo selectors in header/nav
          const logoSelectors = [
            'header img[class*="logo" i]',
            'header img[id*="logo" i]',
            'nav img[class*="logo" i]',
            'nav img[id*="logo" i]',
            '.header img[class*="logo" i]',
            '.navbar img[class*="logo" i]',
            ".site-logo img",
            ".brand img",
            "a.logo img",
            "a.brand img",
            '[class*="header"] img[alt*="logo" i]',
            "header a:first-of-type img",
          ];

          for (const selector of logoSelectors) {
            const logoEl = document.querySelector(selector) as HTMLImageElement;
            if (logoEl && logoEl.src) {
              return {
                url: logoEl.src,
                alt: logoEl.alt || logoEl.getAttribute("title") || null,
              };
            }
          }

          // Strategy 2: Find largest image in header
          const headerImages = document.querySelectorAll(
            "header img, nav img, .header img, .navbar img"
          ) as NodeListOf<HTMLImageElement>;

          let largestImage: HTMLImageElement | null = null;
          let maxSize = 0;

          headerImages.forEach((img: HTMLImageElement) => {
            const size = img.naturalWidth * img.naturalHeight;
            if (size > maxSize && img.src) {
              maxSize = size;
              largestImage = img;
            }
          });

          if (largestImage) {
            const img = largestImage as HTMLImageElement;
            if (img.src) {
              return {
                url: img.src,
                alt: img.alt || img.getAttribute("title") || null,
              };
            }
          }

          // Strategy 3: Check Open Graph image
          const ogImage = document.querySelector(
            'meta[property="og:image"]'
          ) as HTMLMetaElement;
          if (ogImage && ogImage.content) {
            return {
              url: ogImage.content,
              alt: null,
            };
          }

          return { url: null, alt: null };
        })();

        // ============================================
        // 2. FAVICON EXTRACTION
        // ============================================
        const faviconUrl = (() => {
          // Check for favicon link tags
          const faviconSelectors = [
            'link[rel="icon"]',
            'link[rel="shortcut icon"]',
            'link[rel="apple-touch-icon"]',
          ];

          for (const selector of faviconSelectors) {
            const faviconEl = document.querySelector(
              selector
            ) as HTMLLinkElement;
            if (faviconEl && faviconEl.href) {
              return faviconEl.href;
            }
          }

          // Fallback to default favicon location
          return `${window.location.origin}/favicon.ico`;
        })();

        // ============================================
        // 3. META TAGS EXTRACTION
        // ============================================
        const metaTags = Array.from(document.querySelectorAll("meta")).map(
          (m) => ({
            name: m.getAttribute("name") || m.getAttribute("property"),
            content: m.getAttribute("content"),
          })
        );

        // ============================================
        // 4. HEADER-FOCUSED COLOR EXTRACTION
        // ============================================
        const headerColorSet = new Set<string>();
        const allColorSet = new Set<string>();

        // Priority 1: Extract colors from header/nav elements
        const headerElements = document.querySelectorAll(
          "header, header *, nav, nav *, .header, .header *, .navbar, .navbar *, [class*='header'], [class*='nav']"
        );

        headerElements.forEach((el) => {
          const styles = window.getComputedStyle(el);
          ["color", "backgroundColor", "borderColor", "fill"].forEach(
            (prop) => {
              const color = styles[prop as keyof CSSStyleDeclaration];
              if (
                color &&
                color !== "rgba(0, 0, 0, 0)" &&
                color !== "transparent" &&
                color !== "inherit" &&
                typeof color === "string"
              ) {
                headerColorSet.add(color as string);
              }
            }
          );
        });

        // Priority 2: Get theme color from meta tags
        metaTags.forEach((meta) => {
          if (meta.name === "theme-color" && meta.content) {
            headerColorSet.add(meta.content);
          }
        });

        // Priority 3: Extract colors from all elements (as fallback)
        const allElements = document.querySelectorAll("*");
        allElements.forEach((el) => {
          const styles = window.getComputedStyle(el);
          ["color", "backgroundColor", "borderColor"].forEach((prop) => {
            const color = styles[prop as keyof CSSStyleDeclaration];
            if (
              color &&
              color !== "rgba(0, 0, 0, 0)" &&
              color !== "transparent" &&
              color !== "inherit" &&
              typeof color === "string"
            ) {
              allColorSet.add(color as string);
            }
          });
        });

        // ============================================
        // 5. FONT EXTRACTION FROM HEADER
        // ============================================
        const fontSet = new Set<string>();

        // Prioritize header fonts
        headerElements.forEach((el) => {
          const styles = window.getComputedStyle(el);
          const fontFamily = styles.fontFamily;
          if (
            fontFamily &&
            fontFamily !== "inherit" &&
            fontFamily !== "initial" &&
            fontFamily !== "unset"
          ) {
            fontSet.add(fontFamily);
          }
        });

        // Add other fonts if header doesn't have enough
        if (fontSet.size < 2) {
          const headings = document.querySelectorAll("h1, h2, h3, p");
          headings.forEach((el) => {
            const styles = window.getComputedStyle(el);
            const fontFamily = styles.fontFamily;
            if (
              fontFamily &&
              fontFamily !== "inherit" &&
              fontFamily !== "initial" &&
              fontFamily !== "unset"
            ) {
              fontSet.add(fontFamily);
            }
          });
        }

        const result = {
          title: document.title,
          metaTags,
          extractedColors: Array.from(allColorSet),
          extractedFonts: Array.from(fontSet),
          headerColors: Array.from(headerColorSet),
          logoInfo,
          faviconUrl,
        };

        console.log(`✅ Extraction complete:
          - Header colors: ${result.headerColors.length}
          - All colors: ${result.extractedColors.length}
          - Fonts: ${result.extractedFonts.length}
          - Logo: ${result.logoInfo.url ? 'Found' : 'Not found'}
        `);

        return result;
      });

      console.log(`🔄 Scraping completed successfully`);
      console.log(`   - Page title: ${data.title}`);
      console.log(`   - Header colors extracted: ${data.headerColors.length}`);
      console.log(`   - Total colors extracted: ${data.extractedColors.length}`);
      console.log(`   - Sample header colors: ${data.headerColors.slice(0, 5).join(", ")}`);

      console.log(`🔍 Discovering blog pages...`);
      const blogUrls = await this.discoverBlogPages(url, page);
      console.log(`✅ Found ${blogUrls.length} blog pages`);

      let blogImages: Array<{
        url: string;
        alt: string | null;
        blogUrl: string;
        blogTitle: string;
        width: number | null;
        height: number | null;
        type: string;
      }> = [];

      if (blogUrls.length > 0) {
        console.log(`📸 Extracting images from blog pages...`);
        blogImages = await this.extractBlogImages(blogUrls, browser);
        console.log(`✅ Extracted ${blogImages.length} blog images`);
      }

      await browser.close();

      return {
        ...data,
        blogImages,
      };
    } catch (error) {
      await browser.close();
      console.error(`❌ Scraping failed:`, error);
      throw error;
    }
  }

  private async discoverBlogPages(baseUrl: string, page: any): Promise<string[]> {
    try {
      const blogLinks = await page.evaluate(() => {
        const blogLinksArray: string[] = [];
        const currentOrigin = window.location.origin;

        const blogPatterns = [
          '/blog',
          '/articles',
          '/posts',
          '/news',
          '/updates',
          '/insights',
          '/resources',
        ];

        const allLinks = document.querySelectorAll('a[href]');
        Array.from(allLinks).forEach((el) => {
          const link = el as HTMLAnchorElement;
          const href = link.getAttribute('href');
          if (!href) return;

          let absoluteUrl = href;
          if (href.startsWith('/')) {
            absoluteUrl = currentOrigin + href;
          } else if (!href.startsWith('http')) {
            return;
          }

          const urlLower = absoluteUrl.toLowerCase();
          if (
            blogPatterns.some(pattern => urlLower.includes(pattern)) ||
            urlLower.includes('/blog/') ||
            urlLower.includes('/article/') ||
            urlLower.includes('/post/')
          ) {
            if (
              !blogLinksArray.includes(absoluteUrl) &&
              absoluteUrl.startsWith(currentOrigin)
            ) {
              blogLinksArray.push(absoluteUrl);
            }
          }
        });

        return blogLinksArray.slice(0, 10);
      });

      return blogLinks;
    } catch (error) {
      console.error('Error discovering blog pages:', error);
      return [];
    }
  }

  public async extractBlogImagesFromUrls(
    blogUrls: string[]
  ): Promise<Array<{
    url: string;
    alt: string | null;
    blogUrl: string;
    blogTitle: string;
    width: number | null;
    height: number | null;
    type: string;
    qualityScore?: number;
  }>> {
    const browser = await launchStealthBrowser();

    try {
      return await this.extractBlogImages(blogUrls, browser);
    } finally {
      await browser.close();
    }
  }

  public async extractTopImagesFromHomepage(
    homepageUrl: string,
    limit: number = 20
  ): Promise<Array<{
    url: string;
    alt: string | null;
    blogUrl: string;
    blogTitle: string;
    width: number | null;
    height: number | null;
    type: string;
    qualityScore?: number;
  }>> {
    const browser = await launchStealthBrowser();

    try {
      const page = await browser.newPage();
      await page.goto(homepageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const images = await page.evaluate(() => {
        const allImages: Array<{
          url: string;
          alt: string | null;
          width: number | null;
          height: number | null;
          type: string;
          qualityScore?: number;
        }> = [];

        const imageElements = document.querySelectorAll("img");

        imageElements.forEach((img: HTMLImageElement) => {
          if (!img.src || img.src.startsWith("data:")) return;

          const width = img.naturalWidth || 0;
          const height = img.naturalHeight || 0;

          // Relaxed minimum: 400x300px (same as blog images)
          if (width < 400 || height < 300) return;

          // Format validation: exclude SVGs only
          const src = img.src.toLowerCase();
          if (src.includes(".svg") || src.includes("data:image/svg")) return;

          // More lenient aspect ratio validation
          const aspectRatio = width / height;
          const isValidAspectRatio =
            (aspectRatio >= 1.0 && aspectRatio <= 3.0) ||
            (aspectRatio >= 0.5 && aspectRatio <= 1.0);

          // Quality scoring (same as blog images with adjusted tiers)
          let qualityScore = 0;
          const totalPixels = width * height;

          if (totalPixels >= 1920 * 1080) qualityScore += 40;
          else if (totalPixels >= 1280 * 720) qualityScore += 30;
          else if (totalPixels >= 800 * 600) qualityScore += 25;
          else if (totalPixels >= 600 * 400) qualityScore += 20;
          else if (totalPixels >= 400 * 300) qualityScore += 15;
          else qualityScore += 10;

          if (isValidAspectRatio) {
            if (aspectRatio >= 1.5 && aspectRatio <= 1.8) qualityScore += 20;
            else if (aspectRatio >= 1.3 && aspectRatio <= 2.0) qualityScore += 15;
            else if (aspectRatio >= 1.0 && aspectRatio <= 3.0) qualityScore += 10;
            else qualityScore += 5;
          }

          if (src.includes(".jpg") || src.includes(".jpeg")) qualityScore += 20;
          else if (src.includes(".png")) qualityScore += 18;
          else if (src.includes(".webp")) qualityScore += 15;
          else qualityScore += 10;

          if (img.alt && img.alt.length > 10) qualityScore += 10;
          else if (img.alt) qualityScore += 5;

          if (totalPixels > 2000000) qualityScore += 10;
          else if (totalPixels > 1000000) qualityScore += 7;
          else if (totalPixels > 500000) qualityScore += 5;
          else qualityScore += 3;

          // Don't filter here - let sorting handle quality

          let imageType = "body";
          const alt = (img.alt || "").toLowerCase();
          const className = (img.className || "").toLowerCase();
          const parentClass = (img.parentElement?.className || "").toLowerCase();

          if (
            src.includes("featured") ||
            alt.includes("featured") ||
            className.includes("featured") ||
            parentClass.includes("featured") ||
            className.includes("hero") ||
            parentClass.includes("hero") ||
            className.includes("banner") ||
            parentClass.includes("banner")
          ) {
            imageType = "featured";
          }

          allImages.push({
            url: img.src,
            alt: img.alt || null,
            width: width,
            height: height,
            type: imageType,
            qualityScore: qualityScore,
          });
        });

        return allImages;
      });

      // Remove duplicates and apply two-tier quality system
      const uniqueImages = new Map<string, typeof images[0]>();
      images.forEach((img: { url?: string }) => {
        const normalizedUrl = (img.url ?? "").split("?")[0] ?? "";
        if (!uniqueImages.has(normalizedUrl)) {
          uniqueImages.set(normalizedUrl, img as typeof images[0]);
        }
      });

      const allUniqueImages = Array.from(uniqueImages.values());
      
      // First pass: High quality images (score >= 40)
      const highQualityImages = allUniqueImages
        .filter(img => (img.qualityScore || 0) >= 40)
        .sort((a, b) => {
          const scoreA = a.qualityScore || 0;
          const scoreB = b.qualityScore || 0;
          if (scoreB !== scoreA) return scoreB - scoreA;
          const sizeA = (a.width || 0) * (a.height || 0);
          const sizeB = (b.width || 0) * (b.height || 0);
          return sizeB - sizeA;
        });

      // If we have enough high-quality images, use them
      let finalImages = highQualityImages;
      if (highQualityImages.length < 10) {
        // Include medium quality images (score >= 25)
        const mediumQualityImages = allUniqueImages
          .filter(img => {
            const score = img.qualityScore || 0;
            return score >= 25 && score < 40;
          })
          .sort((a, b) => {
            const scoreA = a.qualityScore || 0;
            const scoreB = b.qualityScore || 0;
            if (scoreB !== scoreA) return scoreB - scoreA;
            const sizeA = (a.width || 0) * (a.height || 0);
            const sizeB = (b.width || 0) * (b.height || 0);
            return sizeB - sizeA;
          });

        finalImages = [...highQualityImages, ...mediumQualityImages];

        // If still not enough, include lower quality (score >= 15)
        if (finalImages.length < 20) {
          const lowerQualityImages = allUniqueImages
            .filter(img => {
              const score = img.qualityScore || 0;
              return score >= 15 && score < 25;
            })
            .sort((a, b) => {
              const scoreA = a.qualityScore || 0;
              const scoreB = b.qualityScore || 0;
              if (scoreB !== scoreA) return scoreB - scoreA;
              const sizeA = (a.width || 0) * (a.height || 0);
              const sizeB = (b.width || 0) * (b.height || 0);
              return sizeB - sizeA;
            });

          finalImages = [...finalImages, ...lowerQualityImages];
        }
      }

      const sortedImages = finalImages
        .slice(0, limit)
        .map((img) => ({
          ...img,
          blogUrl: homepageUrl,
          blogTitle: "Homepage",
        }));

      await browser.close();
      return sortedImages;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  private async extractBlogImages(
    blogUrls: string[],
    browser: any
  ): Promise<Array<{
    url: string;
    alt: string | null;
    blogUrl: string;
    blogTitle: string;
    width: number | null;
    height: number | null;
    type: string;
    qualityScore?: number;
  }>> {
    const allImages: Array<{
      url: string;
      alt: string | null;
      blogUrl: string;
      blogTitle: string;
      width: number | null;
      height: number | null;
      type: string;
      qualityScore?: number;
    }> = [];

    // Process more blog URLs (increased from 5 to 15)
    for (const blogUrl of blogUrls.slice(0, 15)) {
      try {
        const page = await browser.newPage();
        await page.goto(blogUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 10000,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const blogData = await page.evaluate(() => {
          const title = document.title ||
            document.querySelector('h1')?.textContent ||
            'Untitled Blog Post';

          const articleSelectors = [
            'article img',
            '.post img',
            '.blog-post img',
            '.article img',
            '.content img',
            'main img',
            '[role="article"] img',
          ];

          const images: Array<{
            url: string;
            alt: string | null;
            width: number | null;
            height: number | null;
            type: string;
            qualityScore?: number;
          }> = [];

          let articleElement: Element | null = null;
          for (const selector of articleSelectors) {
            articleElement = document.querySelector(selector.split(' img')[0] ?? selector);
            if (articleElement) break;
          }

          const imageContainer = articleElement || document.body;
          const imageElements = imageContainer.querySelectorAll('img');

          imageElements.forEach((img: HTMLImageElement) => {
            if (!img.src || img.src.startsWith('data:')) return;

            const width = img.naturalWidth || 0;
            const height = img.naturalHeight || 0;

            // Relaxed minimum: 400x300px (more lenient than 800x600)
            if (width < 400 || height < 300) return;

            // Format validation: exclude SVGs only
            const src = img.src.toLowerCase();
            if (src.includes('.svg') || src.includes('data:image/svg')) return;

            // More lenient aspect ratio validation
            const aspectRatio = width / height;
            const isValidAspectRatio = 
              (aspectRatio >= 1.0 && aspectRatio <= 3.0) || // Wider landscape range
              (aspectRatio >= 0.5 && aspectRatio <= 1.0); // Portrait also acceptable

            // Quality scoring (0-100)
            let qualityScore = 0;
            
            // Resolution score (0-40 points) - adjusted for lower minimum
            const totalPixels = width * height;
            if (totalPixels >= 1920 * 1080) qualityScore += 40; // Full HD+
            else if (totalPixels >= 1280 * 720) qualityScore += 30; // HD
            else if (totalPixels >= 800 * 600) qualityScore += 25; // Good quality
            else if (totalPixels >= 600 * 400) qualityScore += 20; // Medium quality
            else if (totalPixels >= 400 * 300) qualityScore += 15; // Minimum acceptable
            else qualityScore += 10;

            // Aspect ratio score (0-20 points) - more lenient
            if (isValidAspectRatio) {
              if (aspectRatio >= 1.5 && aspectRatio <= 1.8) qualityScore += 20; // Ideal 16:9 range
              else if (aspectRatio >= 1.3 && aspectRatio <= 2.0) qualityScore += 15; // Good landscape
              else if (aspectRatio >= 1.0 && aspectRatio <= 3.0) qualityScore += 10; // Acceptable landscape
              else qualityScore += 5; // Portrait or other - still acceptable
            }

            // Format score (0-20 points)
            if (src.includes('.jpg') || src.includes('.jpeg')) qualityScore += 20;
            else if (src.includes('.png')) qualityScore += 18;
            else if (src.includes('.webp')) qualityScore += 15;
            else qualityScore += 10;

            // Alt text score (0-10 points)
            if (img.alt && img.alt.length > 10) qualityScore += 10;
            else if (img.alt) qualityScore += 5;

            // Size/compression score (0-10 points) - adjusted tiers
            if (totalPixels > 2000000) qualityScore += 10; // Very large
            else if (totalPixels > 1000000) qualityScore += 7;
            else if (totalPixels > 500000) qualityScore += 5; // Medium
            else qualityScore += 3; // Smaller but acceptable

            // Don't filter here - let sorting handle quality
            // We'll use two-tier system: prefer high quality, but include medium if needed

            let imageType = 'body';
            const alt = (img.alt || '').toLowerCase();
            const className = (img.className || '').toLowerCase();
            const parentClass = (img.parentElement?.className || '').toLowerCase();

            if (
              src.includes('featured') ||
              alt.includes('featured') ||
              className.includes('featured') ||
              parentClass.includes('featured') ||
              className.includes('hero') ||
              parentClass.includes('hero')
            ) {
              imageType = 'featured';
            } else if (
              className.includes('gallery') ||
              parentClass.includes('gallery') ||
              className.includes('carousel')
            ) {
              imageType = 'gallery';
            }

            images.push({
              url: img.src,
              alt: img.alt || null,
              width: width,
              height: height,
              type: imageType,
              qualityScore: qualityScore,
            });
          });

          return { title, images };
        });

        blogData.images.forEach((img: { url: string; alt?: string | null; width?: number | null; height?: number | null; type?: string; qualityScore?: number }) => {
          allImages.push({
            url: img.url,
            alt: img.alt ?? null,
            blogUrl,
            blogTitle: blogData.title ?? "",
            width: img.width ?? null,
            height: img.height ?? null,
            type: img.type ?? "unknown",
            qualityScore: img.qualityScore,
          });
        });

        await page.close();
      } catch (error) {
        console.error(`Error extracting images from ${blogUrl}:`, error);
      }
    }

    const uniqueImages = new Map<string, typeof allImages[0]>();
    allImages.forEach((img) => {
      const normalizedUrl = (img.url ?? "").split('?')[0] ?? "";
      if (!uniqueImages.has(normalizedUrl)) {
        uniqueImages.set(normalizedUrl, img);
      }
    });

    // Two-tier quality system: prefer high quality, but include medium if needed
    const allUniqueImages = Array.from(uniqueImages.values());
    
    // First pass: High quality images (score >= 40)
    const highQualityImages = allUniqueImages
      .filter(img => (img.qualityScore || 0) >= 40)
      .sort((a, b) => {
        const scoreA = a.qualityScore || 0;
        const scoreB = b.qualityScore || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        const sizeA = (a.width || 0) * (a.height || 0);
        const sizeB = (b.width || 0) * (b.height || 0);
        return sizeB - sizeA;
      });

    // If we have enough high-quality images, return them
    if (highQualityImages.length >= 10) {
      return highQualityImages.slice(0, 100);
    }

    // Otherwise, include medium quality images (score >= 25)
    const mediumQualityImages = allUniqueImages
      .filter(img => {
        const score = img.qualityScore || 0;
        return score >= 25 && score < 40;
      })
      .sort((a, b) => {
        const scoreA = a.qualityScore || 0;
        const scoreB = b.qualityScore || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        const sizeA = (a.width || 0) * (a.height || 0);
        const sizeB = (b.width || 0) * (b.height || 0);
        return sizeB - sizeA;
      });

    // Combine: high quality first, then medium quality
    const combinedImages = [...highQualityImages, ...mediumQualityImages]
      .slice(0, 100);

    // If still not enough, include lower quality (score >= 15) but prioritize higher scores
    if (combinedImages.length < 20) {
      const lowerQualityImages = allUniqueImages
        .filter(img => {
          const score = img.qualityScore || 0;
          return score >= 15 && score < 25;
        })
        .sort((a, b) => {
          const scoreA = a.qualityScore || 0;
          const scoreB = b.qualityScore || 0;
          if (scoreB !== scoreA) return scoreB - scoreA;
          const sizeA = (a.width || 0) * (a.height || 0);
          const sizeB = (b.width || 0) * (b.height || 0);
          return sizeB - sizeA;
        });

      return [...combinedImages, ...lowerQualityImages]
        .slice(0, 100);
    }

    return combinedImages;
  }

  private extractPrimaryColors(data: ScrapedData): string[] {
    console.log(`📊 Extracting colors from scraped data...`);
    console.log(`   - Header colors found: ${data.headerColors?.length || 0}`);
    console.log(`   - All colors found: ${data.extractedColors?.length || 0}`);

    // PRIORITY 1: Use header colors (most brand-representative)
    const headerColors = data.headerColors || [];
    let cleanHeaderColors = headerColors
      .map((color: string) => this.normalizeColor(color))
      .filter((color: string) => color && this.isValidColor(color));

    console.log(`   - After normalization: ${cleanHeaderColors.length} valid header colors`);

    // PRIORITY 2: Add theme color from meta tags
    if (data.metaTags) {
      data.metaTags.forEach((meta: any) => {
        if (meta.name === "theme-color" && meta.content) {
          const normalizedColor = this.normalizeColor(meta.content);
          if (normalizedColor && !cleanHeaderColors.includes(normalizedColor)) {
            cleanHeaderColors.unshift(normalizedColor); // Add theme color first
            console.log(`   - Added theme color: ${normalizedColor}`);
          }
        }
      });
    }

    // PRIORITY 3: Fallback to all colors if header doesn't have enough
    if (cleanHeaderColors.length < 5) {
      console.log(`   - Not enough header colors (${cleanHeaderColors.length}), using all colors as fallback`);
      const allColors = data.extractedColors || [];
      const cleanAllColors = allColors
        .map((color: string) => this.normalizeColor(color))
        .filter((color: string) => color && this.isValidColor(color));

      console.log(`   - Found ${cleanAllColors.length} valid colors from full page`);

      // Merge unique colors
      cleanAllColors.forEach((color: string) => {
        if (!cleanHeaderColors.includes(color)) {
          cleanHeaderColors.push(color);
        }
      });
    }

    // Remove pure black and white if we have other colors
    if (cleanHeaderColors.length > 3) {
      cleanHeaderColors = cleanHeaderColors.filter(
        (color: string) => !this.isCommonColor(color)
      );
    }

    // Take top 5 colors
    const finalColors = cleanHeaderColors.slice(0, 5);

    console.log(`   ✅ Final primary colors: ${finalColors.join(", ")}`);

    return finalColors.length > 0
      ? finalColors
      : ["#000000", "#ffffff", "#007bff"];
  }

  private extractSecondaryColors(data: ScrapedData): string[] {
    const colors = data.extractedColors || [];

    // Get secondary colors (skip the first few primary ones)
    const secondaryColors = colors
      .map((color: string) => this.normalizeColor(color))
      .filter((color: string) => color && this.isValidColor(color))
      .filter((color: string) => !this.isCommonColor(color))
      .slice(3, 8); // Take colors 3-8 as secondary

    return secondaryColors.length > 0
      ? secondaryColors
      : ["#6c757d", "#28a745", "#dc3545"];
  }

  private extractPrimaryFont(data: ScrapedData): string {
    const fonts = data.extractedFonts || [];

    if (fonts.length === 0) {
      return "Arial, sans-serif";
    }

    // Get the most common font (first one from header)
    const primaryFont = fonts[0];

    // Clean up font family string
    if (!primaryFont) {
      return "Arial, sans-serif";
    }
    return (
      (primaryFont.split(",")[0]?.replace(/['"]/g, "")?.trim() || "Arial") +
      ", sans-serif"
    );
  }

  private normalizeColor(color: string): string {
    // Convert various color formats to hex
    if (color.startsWith("#")) {
      return color.toUpperCase();
    }

    if (color.startsWith("rgb")) {
      // Convert rgb/rgba to hex
      const matches = color.match(/\d+/g);
      if (matches && matches.length >= 3) {
        const r = parseInt(matches[0] || "0");
        const g = parseInt(matches[1] || "0");
        const b = parseInt(matches[2] || "0");
        return `#${r.toString(16).padStart(2, "0")}${g
          .toString(16)
          .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
      }
    }

    return color;
  }

  private isValidColor(color: string): boolean {
    // Check if color is valid hex or named color
    return (
      /^#[0-9A-F]{6}$/i.test(color) ||
      /^#[0-9A-F]{3}$/i.test(color) ||
      [
        "black",
        "white",
        "red",
        "blue",
        "green",
        "yellow",
        "orange",
        "purple",
        "pink",
        "gray",
        "grey",
      ].includes(color.toLowerCase())
    );
  }

  private isCommonColor(color: string): boolean {
    // Filter out pure black and pure white to get brand colors
    const commonColors = ["#000000", "#FFFFFF", "#000", "#FFF"];
    return commonColors.includes(color.toUpperCase());
  }

  private getDefaultBrandData(): BrandData {
    return {
      primaryColors: ["#000000", "#ffffff", "#007bff"],
      secondaryColors: ["#6c757d", "#28a745", "#dc3545"],
      fontFamily: "Arial, sans-serif",
      logoUrl: undefined,
      logoAltText: undefined,
      faviconUrl: undefined,
      referenceImageUrl: undefined,
      analysisSource: "default",
    };
  }
}
