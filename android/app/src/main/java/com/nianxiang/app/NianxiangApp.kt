package com.nianxiang.app

import android.app.Application
import com.nianxiang.app.data.AppContainer

class NianxiangApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
