import Foundation

// MARK: - Decoding helpers

extension KeyedDecodingContainer {
    /// Server payloads evolve; every field falls back to a default instead of failing the whole decode.
    func value<T: Decodable>(_ key: Key, default fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }
}

// MARK: - Auth

struct HealthResponse: Decodable {
    var ok = false
    var mock = false
    var apiVersion = 1
    var authRequired = true
    var bootstrapped = false

    enum CodingKeys: String, CodingKey { case ok, mock, apiVersion, authRequired, bootstrapped }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.value(.ok, default: false)
        mock = c.value(.mock, default: false)
        apiVersion = c.value(.apiVersion, default: 1)
        authRequired = c.value(.authRequired, default: true)
        bootstrapped = c.value(.bootstrapped, default: false)
    }
}

struct AuthUser: Codable, Identifiable, Equatable {
    var id: String
    var username: String
    var displayName: String
    var role = "member"
    var accountType: String?
    var familyId: String?
    var plan: String?
    var disabled = false
    var createdAt: Int64 = 0
    var updatedAt: Int64 = 0

    enum CodingKeys: String, CodingKey {
        case id, username, displayName, role, accountType, familyId, plan, disabled, createdAt, updatedAt
    }

    init(id: String, username: String, displayName: String, role: String = "member", disabled: Bool = false) {
        self.id = id
        self.username = username
        self.displayName = displayName
        self.role = role
        self.disabled = disabled
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        username = c.value(.username, default: "")
        displayName = c.value(.displayName, default: "")
        role = c.value(.role, default: "member")
        accountType = try? c.decodeIfPresent(String.self, forKey: .accountType)
        familyId = try? c.decodeIfPresent(String.self, forKey: .familyId)
        plan = try? c.decodeIfPresent(String.self, forKey: .plan)
        disabled = c.value(.disabled, default: false)
        createdAt = c.value(.createdAt, default: 0)
        updatedAt = c.value(.updatedAt, default: 0)
    }
}

struct AuthResponse: Decodable {
    var accessToken: String
    var refreshToken: String
    var expiresIn = 3600
    var user: AuthUser
    /// One-shot: present on register/bootstrap/recover, and on login/unlock when the
    /// account had no at-rest crypto yet (legacy upgrade path).
    var recoveryCode: String?

    enum CodingKeys: String, CodingKey { case accessToken, refreshToken, expiresIn, user, recoveryCode }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        refreshToken = try c.decode(String.self, forKey: .refreshToken)
        expiresIn = c.value(.expiresIn, default: 3600)
        user = try c.decode(AuthUser.self, forKey: .user)
        recoveryCode = try? c.decodeIfPresent(String.self, forKey: .recoveryCode)
    }
}

// MARK: - Entries

struct ChatMessage: Codable, Equatable, Hashable {
    var role: String
    var content: String
}

struct PersonRef: Codable, Equatable, Hashable {
    var personId: String
    var faceIndex = 0

    enum CodingKeys: String, CodingKey { case personId, faceIndex }

    init(personId: String, faceIndex: Int = 0) {
        self.personId = personId
        self.faceIndex = faceIndex
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        personId = try c.decode(String.self, forKey: .personId)
        faceIndex = c.value(.faceIndex, default: 0)
    }
}

struct Entry: Codable, Identifiable, Equatable {
    var id: String
    var createdAt: Int64 = 0
    var takenAt: Int64 = 0
    var uploadedAt: Int64 = 0
    var dateSource = "now"
    var yearMonth = ""
    var status = "new"
    var title = ""
    var mood = ""
    var diaryText = ""
    var imageDescription = ""
    var chat: [ChatMessage] = []
    var ownerId = ""
    var userId = ""
    var people: [PersonRef] = []
    var unknownFaces = 0
    var faceScannedAt: Int64 = 0
    var clientUploadId = ""

    enum CodingKeys: String, CodingKey {
        case id, createdAt, takenAt, uploadedAt, dateSource, yearMonth, status, title, mood
        case diaryText, imageDescription, chat, ownerId, userId, people, unknownFaces, faceScannedAt, clientUploadId
    }

    init(id: String) { self.id = id }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        createdAt = c.value(.createdAt, default: 0)
        takenAt = c.value(.takenAt, default: 0)
        uploadedAt = c.value(.uploadedAt, default: 0)
        dateSource = c.value(.dateSource, default: "now")
        yearMonth = c.value(.yearMonth, default: "")
        status = c.value(.status, default: "new")
        title = c.value(.title, default: "")
        mood = c.value(.mood, default: "")
        diaryText = c.value(.diaryText, default: "")
        imageDescription = c.value(.imageDescription, default: "")
        chat = c.value(.chat, default: [])
        ownerId = c.value(.ownerId, default: "")
        userId = c.value(.userId, default: "")
        people = c.value(.people, default: [])
        unknownFaces = c.value(.unknownFaces, default: 0)
        faceScannedAt = c.value(.faceScannedAt, default: 0)
        clientUploadId = c.value(.clientUploadId, default: "")
    }
}

struct EntryPage: Decodable {
    var items: [Entry] = []
    var nextCursor: String?

    enum CodingKeys: String, CodingKey { case items, nextCursor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.value(.items, default: [])
        nextCursor = try? c.decodeIfPresent(String.self, forKey: .nextCursor)
    }
}

/// One frame from GET /api/v1/entries/changes. type: cursor|change|resync|ping.
/// seq/entryId/kind are only meaningful for the frame types that carry them.
struct ChangeFrame: Decodable {
    var type = ""
    var seq: Int64 = 0
    var entryId = ""
    var kind = ""

    enum CodingKeys: String, CodingKey { case type, seq, entryId, kind }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.value(.type, default: "")
        seq = c.value(.seq, default: 0)
        entryId = c.value(.entryId, default: "")
        kind = c.value(.kind, default: "")
    }
}

// MARK: - Session

struct AnalyzeResult: Decodable {
    var opener = ""
    var imageDescription = ""
    var mood = ""

    enum CodingKeys: String, CodingKey { case opener, imageDescription, mood }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        opener = c.value(.opener, default: "")
        imageDescription = c.value(.imageDescription, default: "")
        mood = c.value(.mood, default: "")
    }
}

struct SessionAnalysis: Decodable {
    var status = ""
    var reason = ""

    enum CodingKeys: String, CodingKey { case status, reason }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.value(.status, default: "")
        reason = c.value(.reason, default: "")
    }
}

struct SessionOpenResponse: Decodable {
    var entry: Entry
    var analysis = SessionAnalysis()

    enum CodingKeys: String, CodingKey { case entry, analysis }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entry = try c.decode(Entry.self, forKey: .entry)
        analysis = c.value(.analysis, default: SessionAnalysis())
    }
}

// MARK: - People

struct FaceRef: Codable, Equatable, Hashable {
    var entryId: String
    var faceIndex = 0

    enum CodingKeys: String, CodingKey { case entryId, faceIndex }

    init(entryId: String, faceIndex: Int = 0) {
        self.entryId = entryId
        self.faceIndex = faceIndex
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entryId = try c.decode(String.self, forKey: .entryId)
        faceIndex = c.value(.faceIndex, default: 0)
    }

    var cacheKey: String { "\(entryId):\(faceIndex)" }
}

struct PersonDto: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var relation = ""
    var isUser = false
    var createdAt: Int64 = 0
    var updatedAt: Int64 = 0
    var templateCount = 0
    var enrolledFrom: [FaceRef] = []

    enum CodingKeys: String, CodingKey { case id, name, relation, isUser, createdAt, updatedAt, templateCount, enrolledFrom }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.value(.name, default: "")
        relation = c.value(.relation, default: "")
        isUser = c.value(.isUser, default: false)
        createdAt = c.value(.createdAt, default: 0)
        updatedAt = c.value(.updatedAt, default: 0)
        templateCount = c.value(.templateCount, default: 0)
        enrolledFrom = c.value(.enrolledFrom, default: [])
    }
}

struct PeoplePage: Decodable {
    var items: [PersonDto] = []

    enum CodingKeys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.value(.items, default: [])
    }
}

struct FaceCluster: Decodable, Equatable, Hashable {
    var faces: [FaceRef] = []

    enum CodingKeys: String, CodingKey { case faces }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        faces = c.value(.faces, default: [])
    }
}

struct FaceClusterPage: Decodable {
    var items: [FaceCluster] = []

    enum CodingKeys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.value(.items, default: [])
    }
}

// MARK: - Profile

struct MemoryItem: Decodable, Identifiable, Equatable {
    var id: String
    var text: String
    var category = "other"
    var createdAt: Int64 = 0
    var sourceEntryId = ""

    enum CodingKeys: String, CodingKey { case id, text, category, createdAt, sourceEntryId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = c.value(.text, default: "")
        category = c.value(.category, default: "other")
        createdAt = c.value(.createdAt, default: 0)
        sourceEntryId = c.value(.sourceEntryId, default: "")
    }
}

struct ProfileBody: Decodable, Equatable {
    var personality = ""
    var personalityUpdatedAt: Int64 = 0
    var sessionCount = 0
    var mood = ""
    var moodUpdatedAt: Int64 = 0

    enum CodingKeys: String, CodingKey { case personality, personalityUpdatedAt, sessionCount, mood, moodUpdatedAt }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        personality = c.value(.personality, default: "")
        personalityUpdatedAt = c.value(.personalityUpdatedAt, default: 0)
        sessionCount = c.value(.sessionCount, default: 0)
        mood = c.value(.mood, default: "")
        moodUpdatedAt = c.value(.moodUpdatedAt, default: 0)
    }
}

struct ProfileData: Decodable, Equatable {
    var profile = ProfileBody()
    var memories: [MemoryItem] = []

    enum CodingKeys: String, CodingKey { case profile, memories }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profile = c.value(.profile, default: ProfileBody())
        memories = c.value(.memories, default: [])
    }
}

struct MonthlyReview: Decodable, Equatable {
    var yearMonth = ""
    var text = ""
    var generatedAt: Int64 = 0

    enum CodingKeys: String, CodingKey { case yearMonth, text, generatedAt }

    init(yearMonth: String = "", text: String = "", generatedAt: Int64 = 0) {
        self.yearMonth = yearMonth
        self.text = text
        self.generatedAt = generatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        yearMonth = c.value(.yearMonth, default: "")
        text = c.value(.text, default: "")
        generatedAt = c.value(.generatedAt, default: 0)
    }
}

// MARK: - Misc responses

struct ErrorDetail: Decodable {
    var code = ""
    var message = ""

    enum CodingKeys: String, CodingKey { case code, message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = c.value(.code, default: "")
        message = c.value(.message, default: "")
    }
}

struct DuplicateOfDetail: Decodable {
    var id = ""
    var takenAt: Int64 = 0

    enum CodingKeys: String, CodingKey { case id, takenAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, default: "")
        takenAt = c.value(.takenAt, default: 0)
    }
}

struct ErrorBody: Decodable {
    var error: ErrorDetail?
    var duplicateOf: DuplicateOfDetail?
}

struct MeResponse: Decodable {
    var user: AuthUser
    var family: FamilySummary?
    var migrationPending = false
    var locked = false

    enum CodingKeys: String, CodingKey { case user, family, migrationPending, locked }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(AuthUser.self, forKey: .user)
        family = try? c.decodeIfPresent(FamilySummary.self, forKey: .family)
        migrationPending = c.value(.migrationPending, default: false)
        locked = c.value(.locked, default: false)
    }
}

// MARK: - Family / recovery

struct FamilySummary: Decodable, Equatable {
    var id: String
    var name: String
    var ownerId: String

    enum CodingKeys: String, CodingKey { case id, name, ownerId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.value(.name, default: "")
        ownerId = c.value(.ownerId, default: "")
    }
}

struct UnlockResponse: Decodable {
    var ok = false
    var recoveryCode: String?

    enum CodingKeys: String, CodingKey { case ok, recoveryCode }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.value(.ok, default: false)
        recoveryCode = try? c.decodeIfPresent(String.self, forKey: .recoveryCode)
    }
}

struct RecoveryCodeResponse: Decodable {
    var recoveryCode: String

    enum CodingKeys: String, CodingKey { case recoveryCode }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        recoveryCode = c.value(.recoveryCode, default: "")
    }
}

/// Owner-side view of a pending invite (on GET /family).
struct FamilyInvite: Decodable, Identifiable, Equatable {
    var id: String
    var inviteeId: String
    var inviteeName: String
    var createdAt: Int64 = 0

    enum CodingKeys: String, CodingKey { case id, inviteeId, inviteeName, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        inviteeId = c.value(.inviteeId, default: "")
        inviteeName = c.value(.inviteeName, default: "")
        createdAt = c.value(.createdAt, default: 0)
    }
}

struct FamilyInfo: Decodable {
    var family: FamilySummary?
    var members: [AuthUser] = []
    var invites: [FamilyInvite] = []

    enum CodingKeys: String, CodingKey { case family, members, invites }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        family = try? c.decodeIfPresent(FamilySummary.self, forKey: .family)
        members = c.value(.members, default: [])
        invites = c.value(.invites, default: [])
    }
}

/// Invitee-side view of a pending invite (on GET /me/invites).
struct MyInvite: Decodable, Identifiable, Equatable {
    var id: String
    var familyId: String
    var familyName: String
    var inviterName: String
    var createdAt: Int64 = 0

    enum CodingKeys: String, CodingKey { case id, familyId, familyName, inviterName, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        familyId = c.value(.familyId, default: "")
        familyName = c.value(.familyName, default: "")
        inviterName = c.value(.inviterName, default: "")
        createdAt = c.value(.createdAt, default: 0)
    }
}

struct MyInvitePage: Decodable {
    var items: [MyInvite] = []

    enum CodingKeys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.value(.items, default: [])
    }
}

/// createFamily/acceptInvite/leaveFamily inline the caller's freshest AuthUser so the
/// view model can apply it directly instead of round-tripping through GET /auth/me.
struct FamilyActionResponse: Decodable {
    var ok = false
    var family: FamilySummary?
    var user: AuthUser?

    enum CodingKeys: String, CodingKey { case ok, family, user }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.value(.ok, default: false)
        family = try? c.decodeIfPresent(FamilySummary.self, forKey: .family)
        user = try? c.decodeIfPresent(AuthUser.self, forKey: .user)
    }
}

// MARK: - Relationship graph

struct GraphNode: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var relation = ""
    var isUser = false
    var createdAt: Int64 = 0
    var updatedAt: Int64 = 0
    var templateCount = 0
    var enrolledFrom: [FaceRef] = []
    var degree = 0

    enum CodingKeys: String, CodingKey {
        case id, name, relation, isUser, createdAt, updatedAt, templateCount, enrolledFrom, degree
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.value(.name, default: "")
        relation = c.value(.relation, default: "")
        isUser = c.value(.isUser, default: false)
        createdAt = c.value(.createdAt, default: 0)
        updatedAt = c.value(.updatedAt, default: 0)
        templateCount = c.value(.templateCount, default: 0)
        enrolledFrom = c.value(.enrolledFrom, default: [])
        degree = c.value(.degree, default: 0)
    }
}

struct RelationEvidence: Decodable, Equatable {
    var entryId = ""
    var kind = ""
    var createdAt: Int64 = 0

    enum CodingKeys: String, CodingKey { case entryId, kind, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entryId = c.value(.entryId, default: "")
        kind = c.value(.kind, default: "")
        createdAt = c.value(.createdAt, default: 0)
    }
}

struct RelationshipDto: Decodable, Identifiable, Equatable {
    var id: String
    var a: String
    var b: String
    var label = ""
    var confidence: Double = 0
    var evidence: [RelationEvidence] = []
    var createdAt: Int64 = 0
    var updatedAt: Int64 = 0
    /// Synthesized from Person.relation at query time — not persisted, not deletable.
    var virtual = false

    enum CodingKeys: String, CodingKey { case id, a, b, label, confidence, evidence, createdAt, updatedAt, virtual }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        a = c.value(.a, default: "")
        b = c.value(.b, default: "")
        label = c.value(.label, default: "")
        confidence = c.value(.confidence, default: 0)
        evidence = c.value(.evidence, default: [])
        createdAt = c.value(.createdAt, default: 0)
        updatedAt = c.value(.updatedAt, default: 0)
        virtual = c.value(.virtual, default: false)
    }
}

struct GraphResponse: Decodable {
    var nodes: [GraphNode] = []
    var edges: [RelationshipDto] = []

    enum CodingKeys: String, CodingKey { case nodes, edges }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        nodes = c.value(.nodes, default: [])
        edges = c.value(.edges, default: [])
    }
}

struct UserPage: Decodable {
    var items: [AuthUser] = []

    enum CodingKeys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.value(.items, default: [])
    }
}

struct ApiError: Error, LocalizedError {
    let status: Int
    let code: String
    let message: String
    let duplicateOfId: String?
    let duplicateOfTakenAt: Int64?

    init(status: Int, code: String, message: String, duplicateOfId: String? = nil, duplicateOfTakenAt: Int64? = nil) {
        self.status = status
        self.code = code
        self.message = message
        self.duplicateOfId = duplicateOfId
        self.duplicateOfTakenAt = duplicateOfTakenAt
    }

    var errorDescription: String? { message }
}
