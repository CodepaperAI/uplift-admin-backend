import { prisma } from "../config/db.config";
import { launchStealthBrowser } from "../utils/browser.utils";
import { BrandAnalysisService } from "./brand-analysis.service";

export class BlogImageExtractionService {
  private brandAnalysisService: BrandAnalysisService;

  constructor() {
    this.brandAnalysisService = new BrandAnalysisService();
  }

  async extractBlogImages(
    businessId: string,
    websiteUrl: string,
    useSitemap: boolean = true
  ): Promise<{ imageCount: number; source: "sitemap" | "homepage" | "top-images" }> {
    // Try sitemap first if requested
    if (useSitemap) {
      try {
        const sitemap = await prisma.sitemapUrls.findFirst({
          where: { businessId },
        });

        if (sitemap && sitemap.urls.length > 0) {
          console.log(
            `📋 Using sitemap URLs for blog image extraction (${sitemap.urls.length} total URLs)`
          );
          const blogUrls = this.filterBlogUrls(sitemap.urls);

          if (blogUrls.length > 0) {
            console.log(
              `✅ Found ${blogUrls.length} blog URLs from sitemap (filtered from ${sitemap.urls.length} total URLs)`
            );
            const imageCount = await this.extractFromBlogUrls(
              blogUrls,
              businessId
            );
            
            // If no blog images found, fallback to top images from homepage
            if (imageCount === 0) {
              console.log(
                `⚠️ No images extracted from blog URLs, fetching top images from homepage as fallback`
              );
              return await this.extractTopImagesFallback(
                websiteUrl,
                businessId
              );
            }
            
            return { imageCount, source: "sitemap" };
          } else {
            console.log(
              `⚠️ No blog URLs found in sitemap (${sitemap.urls.length} total URLs), trying homepage blog discovery`
            );
          }
        } else {
          console.log(
            `⚠️ No sitemap found in database for business ${businessId}, falling back to homepage discovery`
          );
        }
      } catch (error) {
        console.error(
          `❌ Error accessing sitemap for business ${businessId}:`,
          error
        );
        console.log(`🔄 Falling back to homepage discovery due to error`);
      }
    }

    // Fallback to homepage discovery (current approach)
    console.log(`🔄 Falling back to homepage blog discovery`);
    const blogUrls = await this.discoverBlogPagesFromHomepage(websiteUrl);

    if (blogUrls.length > 0) {
      console.log(`✅ Found ${blogUrls.length} blog URLs from homepage`);
      const imageCount = await this.extractFromBlogUrls(blogUrls, businessId);
      
      // If no blog images found, fallback to top images from homepage
      if (imageCount === 0) {
        console.log(
          `⚠️ No images extracted from blog URLs, fetching top images from homepage as fallback`
        );
        return await this.extractTopImagesFallback(websiteUrl, businessId);
      }
      
      return { imageCount, source: "homepage" };
    }

    // Final fallback: extract top images from homepage
    console.log(
      `⚠️ No blog URLs found from homepage, extracting top images from homepage as fallback`
    );
    return await this.extractTopImagesFallback(websiteUrl, businessId);
  }

  private async extractTopImagesFallback(
    websiteUrl: string,
    businessId: string
  ): Promise<{ imageCount: number; source: "top-images" }> {
    try {
      console.log(`📸 Extracting top quality images from homepage...`);
      const topImages = await this.brandAnalysisService.extractTopImagesFromHomepage(
        websiteUrl,
        30 // Get top 30 images
      );

      if (topImages.length > 0) {
        // Save to database
        await this.saveBlogImages(businessId, topImages);
        console.log(
          `✅ Extracted ${topImages.length} top quality images from homepage`
        );
        return { imageCount: topImages.length, source: "top-images" };
      }

      console.log(`⚠️ No quality images found on homepage`);
      return { imageCount: 0, source: "top-images" };
    } catch (error) {
      console.error(`❌ Error extracting top images from homepage:`, error);
      return { imageCount: 0, source: "top-images" };
    }
  }

  private filterBlogUrls(urls: string[]): string[] {
    const blogPatterns = [
      /\/blog\//i,
      /\/article\//i,
      /\/post\//i,
      /\/news\//i,
      /\/insights\//i,
      /\/resources\//i,
      /\/updates\//i,
      /\/guides\//i,
      /\/tutorials\//i,
      /\/how-to\//i,
    ];

    const filtered = urls.filter((url) => {
      try {
        // Validate URL format
        new URL(url);
        // Check if URL matches blog patterns
        return blogPatterns.some((pattern) => pattern.test(url));
      } catch {
        // Skip invalid URLs
        return false;
      }
    });

    // Remove duplicates
    const uniqueUrls = Array.from(new Set(filtered));

    // Increased limit to 50 blog URLs for better coverage
    return uniqueUrls.slice(0, 50);
  }

  private async extractFromBlogUrls(
    blogUrls: string[],
    businessId: string
  ): Promise<number> {
    try {
      console.log(
        `📸 Starting image extraction from ${blogUrls.length} blog URLs...`
      );
      // Use the existing extractBlogImagesFromUrls method from BrandAnalysisService
      const allImages =
        await this.brandAnalysisService.extractBlogImagesFromUrls(blogUrls);

      console.log(`✅ Extracted ${allImages.length} images from blog URLs`);

      // Save to database
      await this.saveBlogImages(businessId, allImages);

      return allImages.length;
    } catch (error) {
      console.error(
        `❌ Error extracting images from blog URLs:`,
        error
      );
      throw error;
    }
  }

  private async saveBlogImages(
    businessId: string,
    images: Array<{
      url: string;
      alt: string | null;
      blogUrl: string;
      blogTitle: string;
      width: number | null;
      height: number | null;
      type: string;
      qualityScore?: number;
    }>
  ): Promise<void> {
    // Delete old scraped images (keep manual uploads)
    await prisma.blogImage.deleteMany({
      where: {
        businessId,
        source: "scraped",
      },
    });

    // Insert new images
    if (images.length > 0) {
      await prisma.blogImage.createMany({
        data: images.map((img) => ({
          businessId,
          imageUrl: img.url,
          imageAlt: img.alt,
          blogUrl: img.blogUrl,
          blogTitle: img.blogTitle,
          imageType: img.type,
          width: img.width,
          height: img.height,
          source: "scraped",
        })),
      });

      console.log(`✅ Saved ${images.length} blog images to database`);
    }
  }

  private async discoverBlogPagesFromHomepage(
    baseUrl: string
  ): Promise<string[]> {
    // This will use the existing discoverBlogPages logic
    // We'll need to expose it from BrandAnalysisService or duplicate the logic
    try {
      const browser = await launchStealthBrowser();

      try {
        const page = await browser.newPage();
        await page.goto(baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const blogLinks = await page.evaluate(() => {
          const blogLinksArray: string[] = [];
          const currentOrigin = window.location.origin;

          const blogPatterns = [
            "/blog",
            "/articles",
            "/posts",
            "/news",
            "/updates",
            "/insights",
            "/resources",
          ];

          const allLinks = document.querySelectorAll("a[href]");
          allLinks.forEach((link: Element) => {
            const href = link.getAttribute("href");
            if (!href) return;

            let absoluteUrl = href;
            if (href.startsWith("/")) {
              absoluteUrl = currentOrigin + href;
            } else if (!href.startsWith("http")) {
              return;
            }

            const urlLower = absoluteUrl.toLowerCase();
            if (
              blogPatterns.some((pattern) => urlLower.includes(pattern)) ||
              urlLower.includes("/blog/") ||
              urlLower.includes("/article/") ||
              urlLower.includes("/post/")
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

        await browser.close();
        return blogLinks;
      } catch (error) {
        await browser.close();
        throw error;
      }
    } catch (error) {
      console.error("Error discovering blog pages from homepage:", error);
      return [];
    }
  }
}

