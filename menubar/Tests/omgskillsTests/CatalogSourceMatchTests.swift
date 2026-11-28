import Testing
@testable import omgskills

struct CatalogSourceMatchTests {
    @Test func sameLinkOrSameRepositoryMatches() {
        #expect(CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/a/b", catalogSkillId: "a/b:x",
                                                githubUrl: "https://github.com/a/b", movedFromRepo: nil))
        #expect(CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/A/B.git", catalogSkillId: "a/b:x",
                                                githubUrl: "https://github.com/a/b", movedFromRepo: nil))
        #expect(CatalogSourceMatch.isSameSource(installedFrom: nil, catalogSkillId: nil, githubUrl: nil, movedFromRepo: nil))
    }

    @Test func anInstallFromBeforeAConfirmedMoveMatchesTheRepositoryItsIdNames() {
        #expect(CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/Old/tools", catalogSkillId: "old/tools:review",
                                                githubUrl: "https://github.com/New/toolkit", movedFromRepo: "old/tools"))
        #expect(CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/old/root", catalogSkillId: "Old/Root",
                                                githubUrl: "https://github.com/new/root", movedFromRepo: "old/root"))
    }

    @Test func aCopyListedUnderItsUpstreamDoesNotMatchAnUpstreamInstall() {
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/upstream/x", catalogSkillId: "upstream/x:s",
                                                 githubUrl: "https://github.com/fork/x", movedFromRepo: nil))
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/upstream/x", catalogSkillId: "upstream/x:s",
                                                 githubUrl: "https://github.com/fork/x", movedFromRepo: "other/x"))
    }

    @Test func anotherRepositoryDoesNotMatch() {
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/other/repo", catalogSkillId: "old/tools:review",
                                                 githubUrl: "https://github.com/New/toolkit", movedFromRepo: "old/tools"))
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/other/repo", catalogSkillId: nil,
                                                 githubUrl: "https://github.com/New/toolkit", movedFromRepo: nil))
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: nil, catalogSkillId: "a/b", githubUrl: "https://github.com/a/b",
                                                 movedFromRepo: "a/b"))
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: "not a url", catalogSkillId: "a/b", githubUrl: "https://github.com/a/b",
                                                 movedFromRepo: "a/b"))
    }
}
