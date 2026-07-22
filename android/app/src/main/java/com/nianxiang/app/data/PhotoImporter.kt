package com.nianxiang.app.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.exifinterface.media.ExifInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

data class PreparedPhoto(
    val jpeg: ByteArray,
    val thumb: ByteArray,
    val takenAt: Long,
    val dateSource: String,
)

class PhotoImporter(private val context: Context) {
    suspend fun prepare(uri: Uri): PreparedPhoto = withContext(Dispatchers.IO) {
        val metadata = readMetadata(uri)
        val exif = context.contentResolver.openInputStream(uri)?.use(::ExifInterface)
        val (takenAt, dateSource) = resolveDate(exif, metadata.name, metadata.modifiedAt)
        val bitmap = decodeSampled(uri, 2048)
        val oriented = applyOrientation(bitmap, exif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) ?: 1)
        val scaled = scaleDown(oriented, 2048)
        val jpeg = encode(scaled, 88)
        val thumbBitmap = scaleDown(scaled, 480)
        val thumb = encode(thumbBitmap, 80)

        if (thumbBitmap !== scaled) thumbBitmap.recycle()
        if (scaled !== oriented) scaled.recycle()
        if (oriented !== bitmap) oriented.recycle()
        bitmap.recycle()
        PreparedPhoto(jpeg, thumb, takenAt, dateSource)
    }

    private data class Metadata(val name: String, val modifiedAt: Long)

    private fun readMetadata(uri: Uri): Metadata {
        var name = ""
        var modifiedAt = 0L
        context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0) name = cursor.getString(nameIndex).orEmpty()
                for (column in listOf(MediaStore.Images.Media.DATE_TAKEN, "last_modified", "_last_modified")) {
                    val index = cursor.getColumnIndex(column)
                    if (index >= 0) {
                        modifiedAt = cursor.getLong(index)
                        if (modifiedAt in 1..9_999_999_999L) modifiedAt *= 1000
                        if (modifiedAt > 0) break
                    }
                }
            }
        }
        return Metadata(name, modifiedAt)
    }

    private fun resolveDate(exif: ExifInterface?, name: String, modifiedAt: Long): Pair<Long, String> {
        val now = System.currentTimeMillis()
        val parser = SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US).apply { isLenient = false }
        for (tag in listOf(
            ExifInterface.TAG_DATETIME_ORIGINAL,
            ExifInterface.TAG_DATETIME_DIGITIZED,
            ExifInterface.TAG_DATETIME,
        )) {
            val value = exif?.getAttribute(tag) ?: continue
            val time = runCatching { parser.parse(value)?.time }.getOrNull()
            if (time != null && plausible(time, now)) return time to "exif"
        }

        val base = name.substringBeforeLast('.')
        val patterns = listOf(
            Regex("(?:^|[^0-9])(19[0-9]{2}|20[0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])(?:[_-]?([01][0-9]|2[0-3])([0-5][0-9])([0-5][0-9])?)?"),
            Regex("(?:^|[^0-9])(19[0-9]{2}|20[0-9]{2})[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12][0-9]|3[01])(?:[ T_-]([01][0-9]|2[0-3])[:.]([0-5][0-9])(?:[:.]([0-5][0-9]))?)?"),
        )
        for (pattern in patterns) {
            val match = pattern.find(base) ?: continue
            val values = match.groupValues
            val calendar = java.util.Calendar.getInstance().apply {
                isLenient = false
                set(
                    values[1].toInt(),
                    values[2].toInt() - 1,
                    values[3].toInt(),
                    values.getOrNull(4)?.takeIf(String::isNotEmpty)?.toInt() ?: 12,
                    values.getOrNull(5)?.takeIf(String::isNotEmpty)?.toInt() ?: 0,
                    values.getOrNull(6)?.takeIf(String::isNotEmpty)?.toInt() ?: 0,
                )
                set(java.util.Calendar.MILLISECOND, 0)
            }
            val time = runCatching { calendar.timeInMillis }.getOrNull()
            if (time != null && plausible(time, now)) return time to "filename"
        }
        if (plausible(modifiedAt, now)) return modifiedAt to "file"
        return now to "now"
    }

    private fun plausible(time: Long, now: Long): Boolean {
        if (time <= 0 || time > now + 24 * 60 * 60 * 1000L) return false
        val year = SimpleDateFormat("yyyy", Locale.US).format(Date(time)).toIntOrNull() ?: return false
        return year >= 1990
    }

    private fun decodeSampled(uri: Uri, maxSide: Int): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        val boundsStream = context.contentResolver.openInputStream(uri) ?: error("cannot open photo")
        boundsStream.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) error("cannot read photo")
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, options)
        } ?: error("cannot decode photo")
    }

    private fun applyOrientation(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            else -> return bitmap
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun scaleDown(bitmap: Bitmap, maxSide: Int): Bitmap {
        val largest = max(bitmap.width, bitmap.height)
        if (largest <= maxSide) return bitmap
        val scale = maxSide.toFloat() / largest
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * scale).roundToInt().coerceAtLeast(1),
            (bitmap.height * scale).roundToInt().coerceAtLeast(1),
            true,
        )
    }

    private fun encode(bitmap: Bitmap, quality: Int): ByteArray =
        ByteArrayOutputStream().use { out ->
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out))
            out.toByteArray()
        }
}
