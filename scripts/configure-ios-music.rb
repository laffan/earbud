#!/usr/bin/env ruby
# Repeat after `tauri ios init`. Sources and templates remain outside gen/.
require 'xcodeproj'
require 'fileutils'
project_path, app_group, team = ARGV
abort 'Usage: ruby scripts/configure-ios-music.rb src-tauri/gen/apple/earbud.xcodeproj group.<your-id> TEAM_ID' unless project_path && app_group&.start_with?('group.') && team
root = File.expand_path('..', __dir__)
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |t| t.product_type == 'com.apple.product-type.application' }
abort 'Cannot find main app target' unless app
extension = project.targets.find { |t| t.name == 'EarbudAudioShare' } || project.new_target(:app_extension, 'EarbudAudioShare', :ios, '15.0')
source = File.join(root, 'ios-share-extension/ShareViewController.swift')
ref = project.files.find { |f| f.real_path.to_s == source } || project.main_group.new_file(source)
extension.add_file_references([ref]) unless extension.source_build_phase.files_references.include?(ref)
# Generated signing files preserve any existing entitlements.
[app, extension].each do |target|
  entitlement_path = File.join(File.dirname(File.expand_path(project_path)), "#{target.name}-music.entitlements")
  existing_path = target.build_configurations.first.build_settings['CODE_SIGN_ENTITLEMENTS']
  existing_path = File.expand_path(existing_path,File.dirname(File.expand_path(project_path))) if existing_path && !existing_path.include?('$')
  data = if File.exist?(entitlement_path)
    Xcodeproj::Plist.read_from_path(entitlement_path)
  elsif existing_path && File.exist?(existing_path)
    Xcodeproj::Plist.read_from_path(existing_path)
  else
    {}
  end
  data['com.apple.security.application-groups'] = ((data['com.apple.security.application-groups'] || []) + [app_group]).uniq
  Xcodeproj::Plist.write_to_path(data, entitlement_path)
  target.build_configurations.each do |config|
    config.build_settings['CODE_SIGN_ENTITLEMENTS'] = entitlement_path
    config.build_settings['DEVELOPMENT_TEAM'] = team
    config.build_settings['EARBUD_APP_GROUP'] = app_group
    if target == app
      config.build_settings['INFOPLIST_KEY_EarbudAppGroup'] = app_group
      # For projects using a physical Info.plist (Tauri), also merge the key.
      plist = config.build_settings['INFOPLIST_FILE']
      if plist && !plist.include?('$')
        path = File.expand_path(plist,File.dirname(File.expand_path(project_path)))
        if File.exist?(path)
          info = Xcodeproj::Plist.read_from_path(path); info['EarbudAppGroup'] = app_group
          Xcodeproj::Plist.write_to_path(info,path)
        end
      end
    else
      config.build_settings['INFOPLIST_FILE'] = File.join(root,'ios-share-extension/Info.plist')
      config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = "#{app.build_configurations.first.build_settings['PRODUCT_BUNDLE_IDENTIFIER']}.audio-share"
      config.build_settings['SWIFT_VERSION'] = '5.0'
      config.build_settings['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
      config.build_settings['SKIP_INSTALL'] = 'YES'
    end
  end
end
app.add_dependency(extension) unless app.dependencies.any? { |d| d.target == extension }
phase = app.copy_files_build_phases.find { |p| p.name == 'Embed App Extensions' } || app.new_copy_files_build_phase('Embed App Extensions')
phase.dst_subfolder_spec = '13'
unless phase.files_references.include?(extension.product_reference)
  file = phase.add_file_reference(extension.product_reference)
  file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end
project.save
puts "Configured #{app.name} + EarbudAudioShare for #{app_group}. Re-run after regenerating the Tauri project."
