import { prisma } from "../config/db.config";

interface KeywordForClustering {
  keyword: string;
  keywordCategory?: string;
  keywordIntent?: string;
}

interface ClusterAssignment {
  clusterName: string;
  clusterDescription: string;
  pillarKeyword: string;
  clusterKeywords: string[];
}

/**
 * Groups keywords into topical clusters using simple keyword overlap/similarity.
 * Each cluster has one pillar keyword (broadest/highest volume) and related cluster keywords.
 */
export async function assignKeywordClusters(
  keywords: KeywordForClustering[],
  businessId: string,
  userId: string,
): Promise<Map<string, { clusterId: string; clusterRole: "pillar" | "cluster" }>> {
  if (keywords.length < 3) {
    return new Map(); // Too few keywords to cluster
  }

  // Group keywords by shared word stems
  const clusters = groupKeywordsBySimilarity(keywords);

  if (clusters.length === 0) {
    return new Map();
  }

  const assignmentMap = new Map<string, { clusterId: string; clusterRole: "pillar" | "cluster" }>();

  for (const cluster of clusters) {
    if (cluster.clusterKeywords.length < 2) continue; // Skip single-keyword "clusters"

    // Create ContentCluster record
    const contentCluster = await prisma.contentCluster.create({
      data: {
        name: cluster.clusterName,
        description: cluster.clusterDescription,
        businessId,
        userId,
      },
    });

    // Assign pillar
    assignmentMap.set(cluster.pillarKeyword.toLowerCase(), {
      clusterId: contentCluster.id,
      clusterRole: "pillar",
    });

    // Assign cluster members
    for (const kw of cluster.clusterKeywords) {
      if (kw.toLowerCase() !== cluster.pillarKeyword.toLowerCase()) {
        assignmentMap.set(kw.toLowerCase(), {
          clusterId: contentCluster.id,
          clusterRole: "cluster",
        });
      }
    }

    // Update pillarKeywordId after we know which Plan record gets created
    // (This will be done in savePlanKeywords after insert)
  }

  return assignmentMap;
}

/**
 * Simple keyword clustering based on shared significant words.
 * Groups keywords that share 1+ meaningful words (excluding stop words).
 */
function groupKeywordsBySimilarity(keywords: KeywordForClustering[]): ClusterAssignment[] {
  const STOP_WORDS = new Set([
    "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by",
    "from", "and", "or", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "not", "no", "nor", "but",
    "yet", "so", "if", "then", "than", "that", "this", "these", "those",
    "it", "its", "how", "what", "when", "where", "why", "which", "who",
    "best", "top", "vs", "near", "me", "my", "your", "our",
  ]);

  // Extract significant words from each keyword
  const keywordWords = keywords.map((k) => ({
    keyword: k.keyword,
    words: new Set(
      k.keyword
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    ),
  }));

  // Build adjacency: keywords sharing 1+ significant words
  const clusters: Array<Set<number>> = [];
  const assigned = new Set<number>();

  for (let i = 0; i < keywordWords.length; i++) {
    if (assigned.has(i)) continue;

    const cluster = new Set<number>([i]);
    assigned.add(i);

    // Find all keywords sharing significant words with any cluster member
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < keywordWords.length; j++) {
        if (cluster.has(j)) continue;

        // Check if j shares a word with any member of the cluster
        for (const memberIdx of cluster) {
          const candidateWords = keywordWords[j]?.words;
          const memberWords = keywordWords[memberIdx]?.words;
          if (!candidateWords || !memberWords) {
            continue;
          }

          const shared = [...candidateWords].filter((w) =>
            memberWords.has(w)
          );
          if (shared.length >= 1) {
            cluster.add(j);
            assigned.add(j);
            changed = true;
            break;
          }
        }
      }
    }

    if (cluster.size >= 2) {
      clusters.push(cluster);
    }
  }

  // Convert to ClusterAssignment objects
  return clusters.map((cluster) => {
    const members = [...cluster]
      .map((i) => keywordWords[i]?.keyword)
      .filter((keyword): keyword is string => Boolean(keyword));

    // Pillar = shortest keyword (most generic/broad)
    const pillar = members.reduce((a, b) => (a.length <= b.length ? a : b));

    // Cluster name = most common shared word(s)
    const wordCounts = new Map<string, number>();
    for (const idx of cluster) {
      const words = keywordWords[idx]?.words;
      if (!words) {
        continue;
      }

      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      }
    }
    const topWord = [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word)[0] || "general";

    return {
      clusterName: topWord.charAt(0).toUpperCase() + topWord.slice(1),
      clusterDescription: `Topic cluster around "${topWord}" — pillar: "${pillar}"`,
      pillarKeyword: pillar,
      clusterKeywords: members,
    };
  });
}
