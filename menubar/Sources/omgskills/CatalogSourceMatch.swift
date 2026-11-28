import Foundation

/// Whether an install's recorded GitHub link still names the catalog skill it was made from.
///
/// Catalog IDs stay the same when a repository is renamed or transferred, while the skill's link
/// follows the move. An install made before the move records the old link, so it matches when it
/// names the same repository as the current link, or the repository the ID was listed under.
enum CatalogSourceMatch {
    static func isSameSource(installedFrom recorded: String?, catalogSkillId: String?, githubUrl current: String?) -> Bool {
        if recorded == current { return true }
        guard let recorded, let recordedRepo = SkillIdentityResolver.normalizedRepo(from: recorded) else { return false }
        if let current, SkillIdentityResolver.normalizedRepo(from: current) == recordedRepo { return true }
        guard let catalogSkillId else { return false }
        let listedUnder = String(catalogSkillId.split(separator: ":", maxSplits: 1).first ?? "").lowercased()
        return listedUnder.split(separator: "/").count == 2 && listedUnder == recordedRepo
    }
}
