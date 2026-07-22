package com.nianxiang.app.data

import android.content.Context
import java.io.File

class AppContainer(context: Context) {
    val session = SessionStore(context.applicationContext)
    val api = ApiClient(session)
    val photoImporter = PhotoImporter(context.applicationContext)
    val uploadQueue = UploadQueue(File(context.applicationContext.filesDir, "upload_queue"))
    val connectivity = ConnectivityObserver(context.applicationContext)
}
