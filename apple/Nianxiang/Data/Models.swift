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
    var disabled = false
    var createdAt: Int64 = 0
    var updatedAt: Int64 = 0

    enum CodingKeys: String, CodingKey { case id, username, displayName, role, disabled, createdAt, updatedAt }

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

    enum CodingKeys: String, CodingKey { case accessToken, refreshToken, expiresIn, user }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        refreshToken = try c.decode(String.self, forKey: .refreshToken)
        expiresIn = c.value(.expiresIn, default: 3600)
        user = try c.decode(AuthUser.self, forKey: .user)
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

    enum CodingKeys: String, CodingKey {
        case id, createdAt, takenAt, uploadedAt, dateSource, yearMonth, status, title, mood
        case diaryText, imageDescription, chat, ownerId, userId, people, unknownFaces, faceScannedAt
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

struct ErrorBody: Decodable {
    var error: ErrorDetail?
}

struct MeResponse: Decodable { var user: AuthUser }
struct UserResponse: Decodable { var user: AuthUser }

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

    var errorDescription: String? { message }
}
