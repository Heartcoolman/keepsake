package com.nianxiang.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class HealthResponse(
    val ok: Boolean = false,
    val mock: Boolean = false,
    val apiVersion: Int = 1,
    val authRequired: Boolean = true,
    val bootstrapped: Boolean = false,
)

@Serializable
data class AuthUser(
    val id: String,
    val username: String,
    val displayName: String,
    val role: String = "member",
    val accountType: String? = null,
    val familyId: String? = null,
    val plan: String? = null,
    val disabled: Boolean = false,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

@Serializable
data class AuthResponse(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Int = 3600,
    val user: AuthUser,
    val recoveryCode: String? = null,
)

@Serializable
data class FamilySummary(
    val id: String,
    val name: String,
    val ownerId: String,
)

@Serializable
data class UnlockResponse(
    val ok: Boolean = false,
    val recoveryCode: String? = null,
)

@Serializable
data class RecoveryCodeResponse(val recoveryCode: String)

@Serializable
data class FamilyInvite(
    val id: String,
    val inviteeId: String,
    val inviteeName: String,
    val createdAt: Long = 0,
)

@Serializable
data class FamilyInfo(
    val family: FamilySummary? = null,
    val members: List<AuthUser> = emptyList(),
    val invites: List<FamilyInvite> = emptyList(),
)

@Serializable
data class MyInvite(
    val id: String,
    val familyId: String,
    val familyName: String,
    val inviterName: String,
    val createdAt: Long = 0,
)

@Serializable
data class MyInvitePage(val items: List<MyInvite> = emptyList())

/** create/accept/leave inline the actor's freshest AuthUser so callers can skip an
 *  extra /auth/me round trip; not every action returns one (e.g. revoke/remove/decline). */
@Serializable
data class FamilyActionResponse(
    val ok: Boolean = false,
    val family: FamilySummary? = null,
    val user: AuthUser? = null,
)

@Serializable
data class RelationEvidence(
    val entryId: String,
    val kind: String = "",
    val createdAt: Long = 0,
)

@Serializable
data class RelationshipDto(
    val id: String,
    val a: String,
    val b: String,
    val label: String = "",
    val confidence: Double = 0.0,
    val evidence: List<RelationEvidence> = emptyList(),
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    /** synthesized from Person.relation at query time — not deletable */
    val virtual: Boolean = false,
)

@Serializable
data class GraphNode(
    val id: String,
    val name: String,
    val relation: String = "",
    val isUser: Boolean = false,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val templateCount: Int = 0,
    val enrolledFrom: List<FaceRef> = emptyList(),
    val degree: Int = 0,
)

@Serializable
data class GraphResponse(
    val nodes: List<GraphNode> = emptyList(),
    val edges: List<RelationshipDto> = emptyList(),
)

@Serializable
data class ChatMessage(
    val role: String,
    val content: String,
)

@Serializable
data class PersonRef(
    val personId: String,
    val faceIndex: Int = 0,
)

@Serializable
data class Entry(
    val id: String,
    val createdAt: Long = 0,
    val takenAt: Long = 0,
    val uploadedAt: Long = 0,
    val dateSource: String = "now",
    val yearMonth: String = "",
    val status: String = "new",
    val title: String = "",
    val mood: String = "",
    val diaryText: String = "",
    val imageDescription: String = "",
    val chat: List<ChatMessage> = emptyList(),
    val ownerId: String = "",
    val userId: String = "",
    val people: List<PersonRef> = emptyList(),
    val unknownFaces: Int = 0,
    val faceScannedAt: Long = 0,
    val clientUploadId: String = "",
)

@Serializable
data class EntryPage(
    val items: List<Entry> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class SessionAnalysis(
    val status: String = "",
    val reason: String = "",
)

@Serializable
data class SessionOpenResponse(
    val entry: Entry,
    val analysis: SessionAnalysis = SessionAnalysis(),
)

@Serializable
data class PersonDto(
    val id: String,
    val name: String,
    val relation: String = "",
    val isUser: Boolean = false,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val templateCount: Int = 0,
    val enrolledFrom: List<FaceRef> = emptyList(),
)

@Serializable
data class FaceRef(
    val entryId: String,
    val faceIndex: Int = 0,
)

@Serializable
data class PeoplePage(val items: List<PersonDto> = emptyList())

@Serializable
data class FaceCluster(val faces: List<FaceRef> = emptyList())

@Serializable
data class FaceClusterPage(val items: List<FaceCluster> = emptyList())

@Serializable
data class MemoryItem(
    val id: String,
    val text: String,
    val category: String = "other",
    val createdAt: Long = 0,
    val sourceEntryId: String = "",
)

@Serializable
data class ProfileData(
    val profile: ProfileBody = ProfileBody(),
    val memories: List<MemoryItem> = emptyList(),
)

@Serializable
data class ProfileBody(
    val personality: String = "",
    val personalityUpdatedAt: Long = 0,
    val sessionCount: Int = 0,
    val mood: String = "",
    val moodUpdatedAt: Long = 0,
)

@Serializable
data class MonthlyReview(
    val yearMonth: String = "",
    val text: String = "",
    val generatedAt: Long = 0,
)

/** One SSE frame from GET /entries/changes. Shared shape for cursor|change|resync|ping; unused fields default. */
@Serializable
data class ChangeEvent(
    val type: String,
    val seq: Long = 0,
    val entryId: String = "",
    val kind: String = "",
)

@Serializable
data class ErrorBody(val error: ErrorDetail? = null, val duplicateOf: DuplicateOf? = null)

@Serializable
data class ErrorDetail(val code: String = "", val message: String = "")

@Serializable
data class DuplicateOf(val id: String = "", val takenAt: Long = 0)

@Serializable
data class MeResponse(
    val user: AuthUser,
    val family: FamilySummary? = null,
    val migrationPending: Boolean = false,
    val locked: Boolean = false,
)

@Serializable
data class UserPage(val items: List<AuthUser> = emptyList())

@Serializable
data class OkResponse(val ok: Boolean = false)

class ApiException(
    val status: Int,
    val code: String,
    override val message: String,
    val duplicateEntryId: String? = null,
    val duplicateTakenAt: Long? = null,
) : IllegalStateException(message)
