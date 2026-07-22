/** PUBLIC STUB — the real ParticleView is an OpenGL ES 3.1 compute-shader particle
 *  system (spring/curl physics, bokeh, sand-burst, text dissolve) and lives in the
 *  private core module. This stub keeps the exact public API and draws the submitted
 *  photo as a static cover-fit bitmap, so the app remains fully usable without the
 *  particle effects. Gesture/camera methods are no-ops (there is no 3D camera). */
package com.nianxiang.app.particle

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import java.util.concurrent.Executors

class ParticleView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    interface Listener {
        fun onPhotoPrepared(photoId: String) = Unit
        fun onEntranceStarted(photoId: String) = Unit
        fun onRenderError(message: String) = Unit
        fun onPerformanceSample(sample: ParticlePerformanceSample) = Unit
    }

    var listener: Listener? = null

    private val worker = Executors.newSingleThreadExecutor { task ->
        Thread(task, "particle-stub-decode").apply { priority = Thread.NORM_PRIORITY - 1 }
    }
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    private var bitmap: Bitmap? = null
    private var shownPhotoId: String? = null
    private var decodingPhotoId: String? = null

    fun submit(scene: ParticleSceneState) {
        val photoId = scene.photoId
        if (photoId == null) {
            shownPhotoId = null
            decodingPhotoId = null
            bitmap = null
            invalidate()
            return
        }
        if (photoId == shownPhotoId || photoId == decodingPhotoId || scene.jpeg == null) return
        decodingPhotoId = photoId
        val jpeg = scene.jpeg
        worker.execute {
            val decoded = runCatching { decodeCapped(jpeg) }.getOrNull()
            post {
                if (decodingPhotoId != photoId) return@post
                decodingPhotoId = null
                if (decoded == null) {
                    listener?.onRenderError("photo decode failed")
                    return@post
                }
                bitmap = decoded
                shownPhotoId = photoId
                invalidate()
                listener?.onPhotoPrepared(photoId)
                listener?.onEntranceStarted(photoId)
            }
        }
    }

    /** cap the decode around 2048px on the long side — it is only ever drawn once */
    private fun decodeCapped(jpeg: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 2048) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, opts)
    }

    fun setTestConfiguration(
        particleBudget: Int,
        seed: Int?,
        animationTimeSeconds: Float? = null,
    ) {
        // no renderer in the public build
    }

    fun orbitBy(deltaX: Float, deltaY: Float, screenX: Float, screenY: Float) = Unit
    fun zoomBy(scaleFactor: Float) = Unit
    fun pulseAt(screenX: Float, screenY: Float) = Unit
    fun resetCamera() = Unit
    fun clearParticleFocus() = Unit

    fun release() {
        worker.shutdownNow()
        bitmap = null
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(Color.BLACK)
        val image = bitmap ?: return
        val scale = maxOf(width.toFloat() / image.width, height.toFloat() / image.height)
        val matrix = Matrix().apply {
            setScale(scale, scale)
            postTranslate((width - image.width * scale) / 2f, (height - image.height * scale) / 2f)
        }
        canvas.drawBitmap(image, matrix, paint)
    }
}
