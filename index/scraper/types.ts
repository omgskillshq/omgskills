export interface Skill {
  id: string;
  name: string;
  description: string;
  github_url: string;
  skill_md_path?: string;
  repo_slug?: string;
  repo_commit_sha?: string;
  skill_tree_sha?: string;
  install_target_name?: string;
  install_cmd: string;
  /**
   * The repository the ID was listed under, when GitHub has confirmed it now serves github_url's
   * repository (a rename or transfer). Marks the skill as the original, not a repackaged copy.
   */
  moved_from_repo?: string;
  /**
   * The day (YYYY-MM-DD) GitHub first said github_url's repository doesn't exist. A second miss a
   * week later removes the skill; the mark clears when GitHub serves the repository again.
   */
  repo_missing_since?: string;
  author_handle: string;
  tags: string[];
  stars: number;
  last_updated: string;
  first_seen: string;
  skill_md_sha?: string;
  readme_snippet?: string;
  quality_tier?: "curated" | "creator" | "validated";
  source_tag?: string;
  source_url?: string;
  tweet_url?: string;
  tweet_likes?: number;
  tweet_retweets?: number;
  tweet_replies?: number;
  tweet_views?: number;
  tweet_author_handle?: string;
  tweet_author_name?: string;
  tweet_posted_at?: string | null;
  tweet_text?: string;
}
