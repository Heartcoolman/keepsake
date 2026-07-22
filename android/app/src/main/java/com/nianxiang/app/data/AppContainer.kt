package com.nianxiang.app.data

import android.content.Context

class AppContainer(context: Context) {
    val session = SessionStore(context.applicationContext)
    val api = ApiClient(session)
    val photoImporter = PhotoImporter(context.applicationContext)
}
