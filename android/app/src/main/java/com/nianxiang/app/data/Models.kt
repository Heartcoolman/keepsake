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

@Serializable
data class ErrorBody(val error: ErrorDetail? = null)

@Serializable
data class ErrorDetail(val code: String = "", val message: String = "")

@Serializable
data class MeResponse(val user: AuthUser)

@Serializable
data class UserResponse(val user: AuthUser)

@Serializable
data class UserPage(val items: List<AuthUser> = emptyList())

@Serializable
data class OkResponse(val ok: Boolean = false)

class ApiException(
    val status: Int,
    val code: String,
    override val message: String,
) : IllegalStateException(message)
