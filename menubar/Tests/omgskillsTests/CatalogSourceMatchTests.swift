import Testing
@testable import omgskills

struct CatalogSourceMatchTests {
    @Test func sameLinkOrSameRepositoryMatches() {
        #expect(CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/a/b", catalogSkillId: "a/b:x", githubUrl: "https://github.com/a/b"))
        #expect(CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/A/B.git", catalogSkillId: "a/b:x", githubUrl: "https://github.com/a/b"))
        #expect(CatalogSourceMatch.isSameSource(installedFrom: nil, catalogSkillId: nil, githubUrl: nil))
    }

    @Test func anInstallFromBeforeAMoveMatchesTheRepositoryItsIdNames() {
        #expect(CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/Old/tools", catalogSkillId: "old/tools:review",
                                                githubUrl: "https://github.com/New/toolkit"))
        #expect(CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/old/root", catalogSkillId: "old/root",
                                                githubUrl: "https://github.com/new/root"))
    }

    @Test func anotherRepositoryDoesNotMatch() {
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/other/repo", catalogSkillId: "old/tools:review",
                                                 githubUrl: "https://github.com/New/toolkit"))
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: "https://github.com/other/repo", catalogSkillId: nil,
                                                 githubUrl: "https://github.com/New/toolkit"))
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: nil, catalogSkillId: "a/b", githubUrl: "https://github.com/a/b"))
        #expect(!CatalogSourceMatch.isSameSource(installedFrom: "not a url", catalogSkillId: "a/b", githubUrl: "https://github.com/a/b"))
    }
}
